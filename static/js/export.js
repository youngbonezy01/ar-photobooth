// The strip canvas is drawn at 300 pixels per inch, so a 600px solo strip is
// 2in wide (a real photobooth strip) and a 6-person sheet is about 7.2in wide.
const PX_PER_INCH = 300;

function downloadStripAsImage() {
  const canvas = document.getElementById("strip-canvas");
  if (!canvas) {
    console.error("Strip canvas not found");
    return;
  }

  // Convert the canvas content to a JPEG data URL (0.95 is 95% quality)
  // You can change "image/jpeg" to "image/png" if you prefer lossless PNG files
  const imgData = canvas.toDataURL("image/jpeg", 0.95);

  // Create a temporary anchor element to trigger the browser download
  const link = document.createElement("a");
  link.href = imgData;
  link.download = "photo-strip.jpg"; // The filename the user will see

  // Append to body, trigger click, and clean up
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function printStrip() {
  window.print();
}