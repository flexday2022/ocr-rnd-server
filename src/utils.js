export const convertBarcode = (barcode = "") => {
  if (!barcode) return "-";
  // 공백 제거
  // 하이픈 제거
  return barcode.replace(/ /g, "").replace(/-/g, "");
};

export const removeWordBreak = (str = "") => {
  if (!str) return null;
  return str.replace(/\n/g, "");
};

export const synonymProcessing = ({ title, str }) => {
  if (!str) return "-";
  if (title === "menu") {
    return str
      .replace(/ㅣ/g, "T")
      .replace(/ㅜ/g, "T")
      .replace(/ㅠ/g, "T")
      .replace(/탱스/g, "땡스")
      .replace(/팽스/g, "땡스")
      .replace(/싱글레글러/g, "싱글레귤러")
      .replace(/브루\n더/g, "브루\nT")
      .replace(/스타먹스/g, "스타벅스");
  }
  if (title === "usable") {
    return str.replace(/스타먹스/g, "스타벅스");
  }
  if (title === "store") {
    return str.replace(/스타먹스/g, "스타벅스");
  }
  // if (title === "expire") {
  //   return str
  //     .replace(/s/g, "5")
  //     .replace(/S/g, "5")
  //     .replace(/§/g, "5")
  //     .replace(/OR/g, "08")
  //     .replace(/Ne/g, "02")
  //     .replace(/M/g, "01")
  //     .replace(/IE/g, "16");
  // }
  return str;
};
