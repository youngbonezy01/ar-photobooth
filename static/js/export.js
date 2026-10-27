function downloadStripAsPdf() {
  const canvas = document.getElementById("strip-canvas");
  const { jsPDF } = window.jspdf;

  // 600px canvas width = 2in real photo-strip width, at 300dpi
  const widthIn = 2;
  const heightIn = (canvas.height / canvas.width) * widthIn;

  const doc = new jsPDF({
    orientation: heightIn >= widthIn ? "portrait" : "landscape",
    unit: "in",
    format: [widthIn, heightIn],
  });

  const imgData = canvas.toDataURL("image/jpeg", 0.95);
  doc.addImage(imgData, "JPEG", 0, 0, widthIn, heightIn);
  doc.save("photo-strip.pdf");
}

function printStrip() {
  window.print();
}
