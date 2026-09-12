const showcaseImages = [...document.querySelectorAll<HTMLImageElement>('.showcase-capture img')];

function markImageReadiness(image: HTMLImageElement): void {
  image.addEventListener('load', () => image.dataset.ready = 'true', { once: true });
  image.addEventListener('error', () => image.dataset.ready = 'false', { once: true });
  if (image.complete) image.dataset.ready = image.naturalWidth > 0 ? 'true' : 'false';
}

for (const image of showcaseImages) markImageReadiness(image);
