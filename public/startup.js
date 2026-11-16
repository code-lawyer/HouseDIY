// A file preview cannot start the desktop service or load the app's modules.
if (location.protocol === "file:") {
  document.body.classList.add("file-preview");
  document.querySelector("#file-entry").hidden = false;
  document.querySelector("#desktop-program-path").textContent =
    decodeURIComponent(new URL("../release", location.href).pathname)
      .replace(/^\/([A-Za-z]:)/, "$1")
      .replaceAll("/", "\\");
} else {
  import("./app.js");
}
