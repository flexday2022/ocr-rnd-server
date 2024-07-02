import { config } from "dotenv";
import express from "express";
import fs from "fs";
import morgan from "morgan";
import API from "./api";
import multer from "multer";
import FormData from "form-data";
import cors from "cors";

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
      .then((res) => res.data.images[0].fields)
      .catch((err) => {
        error = true;
        return err.response.data;
      });
    if (error) {
      res.status(400).json({ error: result.code });
    } else {
      res.status(200).json(result);
    }
  });

  app.listen(PORT, () => {
    console.log("server is running at http://localhost:" + PORT);
  });
};

startServer();
