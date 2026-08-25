const visit = new URLSearchParams(window.location.search).get("visit");
document.body.dataset.target = visit === "delayed"
  ? "/delayed-picture-naming/"
  : "/immediate-picture-naming/";
await import("/js/entry.js");
