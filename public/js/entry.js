const targetPath = document.body.dataset.target;
if (!targetPath) throw new Error("Entry target is missing");
const target = new URL(targetPath, window.location.origin);
const source = new URL(window.location.href);
source.searchParams.forEach((value, key) => target.searchParams.set(key, value));
target.hash = source.hash;
window.location.replace(target.toString());
