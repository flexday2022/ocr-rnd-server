/* eslint-disable no-undef */
import axios from "axios";
import { config } from "dotenv";
config();
const API = axios.create({
  baseURL: process.env.NCP_OCR_URL,
  headers: {
    "Content-Type": "multipart/form-data",
    "X-OCR-SECRET": process.env.X_OCR_SECRET,
  },
});

export default API;
