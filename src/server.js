import { config } from "dotenv";
import express from "express";
import fs from "fs";
import morgan from "morgan";
import API from "./api";
import multer from "multer";
import FormData from "form-data";
import cors from "cors";
import { convertBarcode, removeWordBreak, synonymProcessing } from "./utils";
import { createScheduler, createWorker } from "tesseract.js";
import { couponRectangles, couponTemplates, coupons } from "./constants";
import imageSize from "image-size";

config();
const upload = multer();
// eslint-disable-next-line no-undef
const PORT = process.env.PORT;

const startServer = async () => {
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
  app.post("/", upload.single("file"), async (req, res) => {
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

    const formData = new FormData();
    formData.append(
      "message",
      JSON.stringify({
        version: "V2",
        requestId: "" + Date.now(),
        timestamp: Date.now(),
        lang: "ko",
        images: [
          {
            name: req.file.originalname,
            format: req.file.mimetype.split("/")[1],
          },
        ],
      })
    );
    formData.append("file", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });
    let error = false;
    const result = await API.post(null, formData)
      .then((res) => {
        console.log(JSON.stringify(res.data));
        return res.data.images[0].fields;
      })
      .catch((err) => {
        error = true;
        return err.response.data;
      });
    if (error) {
      res.status(400).json({ error: result.code });
    } else {
      // res.status(400).json({ error: "에러발생" });
      const barcode = convertBarcode(
        result.find((i) => i.name === "barcode").inferText
      );
      if (barcode === "-") res.status(404).json({ error: "바코드 인식 실패" });
      res.status(200).json({ usable: true, result });
    }
  });

  app.post("/ocr", upload.single("file"), async (req, res) => {
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

    const rectangles = couponRectangles.find(
      (i) => i.couponType === couponType
    )?.rectangles;
    if (!rectangles) {
      res
        .status(400)
        .json({ message: "학습되지 않은 형태의 기프티콘 입니다." });
      return;
    }

    // 스케쥴러 사용
    // 각 워커마다 langs 지정 불가능
    // 워커 여러 개 생성하는 것보다 빠름
    // const ocrScheduler = createScheduler();
    // const ocrWorkerGen = async () => {
    //   const ocrWorker = await createWorker(["kor", "eng"]);
    //   ocrScheduler.addWorker(ocrWorker);
    // };
    // const resArr = Array(rectangles.length);
    // for (let i = 0; i < rectangles.length; i++) {
    //   resArr[i] = ocrWorkerGen();
    // }
    // await Promise.all(resArr);
    // const results = await Promise.all(
    //   rectangles.map((r) =>
    //     ocrScheduler
    //       .addJob("recognize", req.file.buffer, {
    //         rectangle: r.rectangle,
    //       })
    //       .then((res) => ({ name: r.title, inferText: res.data.text }))
    //       .catch(() => ({ name: r.title, inferText: "" }))
    //   )
    // );
    // await ocrScheduler.terminate();

    // 여러 워커 사용
    // 각 워커마다 langs 지정 가능
    // 스케쥴러 사용하는 것보다 느림
    const ocrWorkers = await Promise.all(
      rectangles.map(async (r) => {
        const worker = await createWorker(r.langs);
        if (r?.whitelist) {
          await worker.setParameters({ tessedit_char_whitelist: r.whitelist });
        }
        return worker;
      })
    );
    const startDateTime = Date.now();
    const result = await Promise.all(
      ocrWorkers.map(async (worker, index) => {
        const result = await worker
          .recognize(req.file.buffer, {
            rectangle: rectangles[index].rectangle,
          })
          .then((res) => ({
            name: rectangles[index].title,
            inferText: synonymProcessing({
              title: rectangles[index].title,
              str: res.data.text,
            }),
          }))
          .catch(() => ({ name: rectangles[index].title, inferText: "" }));
        return result;
      })
    );
    const endDateTime = Date.now();
    const sortingTime = endDateTime - startDateTime;
    await Promise.all(ocrWorkers.map((worker) => worker.terminate()));
    res.status(200).json({ couponType, result, sortingTime });
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
    const ocrWorkers = await Promise.all(
      rectangles.map(async (r) => {
        const worker = await createWorker(r.langs);
        if (r?.whitelist) {
          await worker.setParameters({ tessedit_char_whitelist: r.whitelist });
        }
        return worker;
      })
    );

    const result = await Promise.all(
      ocrWorkers.map(async (worker, index) => {
        const result = await worker
          .recognize(req.file.buffer, {
            rectangle: rectangles[index].rectangle,
          })
          .then((res) => ({
            name: rectangles[index].title,
            inferText: synonymProcessing({
              title: rectangles[index].title,
              str: res.data.text,
            }),
          }))
          .catch(() => ({ name: rectangles[index].title, inferText: "" }));
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
