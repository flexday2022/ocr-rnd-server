import { config } from "dotenv";
import express from "express";
import fs from "fs";
import morgan from "morgan";
import multer from "multer";
import cors from "cors";
import { removeWordBreak, synonymProcessing } from "./utils";
import { createScheduler, createWorker } from "tesseract.js";
import { couponRectangles, couponTemplates, coupons } from "./constants";
import imageSize from "image-size";

config();
const upload = multer();
// eslint-disable-next-line no-undef
const PORT = process.env.PORT;

const ocrWorkers = [];

const initializeWorker = async (langs, whitelist) => {
  const worker = await createWorker(langs);
  if (whitelist) {
    await worker.setParameters({ tessedit_char_whitelist: whitelist });
  }
  return worker;
};

const startServer = async () => {
  //  서버 시작 전, OCR Worker 전부 세팅
  for (let i of couponRectangles) {
    for (let r of i.rectangles) {
      const worker = await initializeWorker(r.langs, r.whitelist);
      ocrWorkers.push({
        couponType: i.couponType,
        title: r.title,
        rectangle: r.rectangle,
        worker,
      });
    }
  }

  const app = express();
  app.use(cors());
  app.use(
    morgan("combined", {
      stream: fs.createWriteStream("log.log", { flags: "a" }),
    })
  );
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get("/favicon.ico", (req, res) => res.status(204).end());
  app.get("/", (req, res) => {
    res.json({ ok: true });
  });

  app.post("/ocr/template", upload.single("file"), async (req, res) => {
    if (!req.file) {
      res.status(400).json({
        message: "이미지를 첨부해주세요.",
      });
      return;
    }
    if (!req.file.mimetype || !req.file.mimetype.includes("image")) {
      res.status(400).json({ message: "이미지만 처리 가능합니다." });
      return;
    }
    let couponType = null;
    const { width, height } = imageSize(req.file.buffer);
    const templateScheduler = createScheduler();

    for (let template of couponTemplates) {
      if (
        width <
        template.templateRecognizerRectangle.left +
          template.templateRecognizerRectangle.width
      ) {
        // 템플릿 검사 구역이 이미지 넓이를 초과하는 경우
        // console.log("width not correct template");
        continue;
      }
      if (
        height <
        template.templateRecognizerRectangle.top +
          template.templateRecognizerRectangle.height
      ) {
        // 템플릿 검사 구역이 이미지 높이를 초과하는 경우
        // console.log("height not correct template");
        continue;
      }
      const templateWorker = await createWorker(["kor", "eng"]);
      templateScheduler.addWorker(templateWorker);
      const templateLoop = await templateScheduler
        .addJob("recognize", req.file.buffer, {
          rectangle: template.templateRecognizerRectangle,
        })
        .then((x) => {
          if (removeWordBreak(x.data.text) === template.templateRecognizer) {
            return template.couponType;
          } else {
            return null;
          }
        })
        .catch(() => {
          return null;
        });
      if (templateLoop) {
        couponType = templateLoop;
      }
    }

    await templateScheduler.terminate();
    if (!couponType) {
      res.status(400).json({
        message:
          "기프티콘 분류에 실패했습니다.\n미리 학습된 템플릿과 일치하는 기프티콘 이미지인지 확인해주세요.",
      });
      return;
    }
    res.status(200).json({ couponType });
  });

  app.post("/ocr/classification", upload.single("file"), async (req, res) => {
    if (!req.file) {
      res.status(400).json({
        message: "이미지를 첨부해주세요.",
      });
      return;
    }
    if (!req.file.mimetype || !req.file.mimetype.includes("image")) {
      res.status(400).json({ message: "이미지만 처리 가능합니다." });
      return;
    }

    if (!req?.body?.couponType) {
      res.status(400).json({
        message: "기프티콘 타입은 필수 값입니다.",
      });
      return;
    }

    const startDateTime = Date.now();
    const rectangles = couponRectangles.find(
      (i) => i.couponType === req.body.couponType
    )?.rectangles;
    if (!rectangles) {
      res
        .status(400)
        .json({ message: "학습되지 않은 형태의 기프티콘 입니다." });
      return;
    }
    // const ocrWorkers = await Promise.all(
    //   rectangles.map(async (r) => {
    //     const worker = await createWorker(r.langs);
    //     if (r?.whitelist) {
    //       await worker.setParameters({ tessedit_char_whitelist: r.whitelist });
    //     }
    //     return worker;
    //   })
    // );

    // const result = await Promise.all(
    //   ocrWorkers.map(async (worker, index) => {
    //     const result = await worker
    //       .recognize(req.file.buffer, {
    //         rectangle: rectangles[index].rectangle,
    //       })
    //       .then((res) => ({
    //         name: rectangles[index].title,
    //         inferText: synonymProcessing({
    //           title: rectangles[index].title,
    //           str: res.data.text,
    //         }),
    //       }))
    //       .catch(() => ({ name: rectangles[index].title, inferText: "" }));
    //     return result;
    //   })
    // );

    const workers = ocrWorkers.filter(
      (w) => w.couponType === req.body.couponType
    );
    const result = await Promise.all(
      workers.map(async (w) => {
        const result = await w.worker
          .recognize(req.file.buffer, {
            rectangle: w.rectangle,
          })
          .then((res) => ({
            name: w.title,
            inferText: synonymProcessing({
              title: w.title,
              str: res.data.text,
            }),
          }))
          .catch(() => ({ name: w.title, inferText: "" }));
        return result;
      })
    );

    const endDateTime = Date.now();
    const sortingTime = endDateTime - startDateTime;
    await Promise.all(ocrWorkers.map((worker) => worker.terminate()));
    res
      .status(200)
      .json({ couponType: req.body.couponType, result, sortingTime });
  });

  app.post("/check", (req, res) => {
    if (!req?.body?.barcode) {
      res.status(400).json({
        message: "쿠폰 정보를 입력해주세요.",
      });
      return;
    }
    if (!req?.body?.expire) {
      res.status(400).json({
        message: "쿠폰 정보를 입력해주세요.",
      });
      return;
    }
    const coupon = coupons.find((c) => c.barcode === req.body.barcode);
    if (!coupon) {
      res
        .status(400)
        .json({ message: "사용 불가능\n존재하지 않는 쿠폰입니다." });
      return;
    }
    if (coupon.expire !== req.body.expire) {
      res.status(400).json({ message: "사용 불가능\n위변조된 쿠폰입니다." });
      return;
    }
    res.status(200).json({ use: coupon.use });
  });

  app.listen(PORT, () => {
    console.log("server is running at http://localhost:" + PORT);
  });
};

startServer();
