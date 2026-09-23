// Size the printed step numeral to the eyebrow/title stack, excluding source metadata.
const ns = 'http://www.w3.org/2000/svg';
await document.fonts.ready;
for (const header of document.querySelectorAll('.stage-header')) {
  const number = header.querySelector('.stage-number');
  const eyebrow = header.querySelector('.stage-eyebrow');
  const title = header.querySelector('h1,h2');
  if (!number || !eyebrow || !title) continue;
  const svg = document.createElementNS(ns, 'svg');
  const text = document.createElementNS(ns, 'text');
  text.textContent = number.textContent.trim();
  text.setAttribute('x', '0'); text.setAttribute('y', '0');
  text.setAttribute('fill', 'currentColor');
  text.style.cssText = 'font:400 100px Barlow;letter-spacing:-6px';
  svg.setAttribute('aria-hidden', 'true'); svg.append(text);
  number.replaceChildren(svg);
  const context = document.createElement('canvas').getContext('2d');
  context.font = '400 100px Barlow';
  context.letterSpacing = '-6px';
  const align = () => {
    if (!header.getClientRects().length) return;
    const metrics = context.measureText(text.textContent);
    const box = {x:-metrics.actualBoundingBoxLeft, y:-metrics.actualBoundingBoxAscent, width:metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight, height:metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent};
    if (!box.height) return;
    const top = eyebrow.getBoundingClientRect().top;
    const titleStyle = getComputedStyle(title);
    const titleContext = document.createElement('canvas').getContext('2d');
    titleContext.font = `${titleStyle.fontWeight} ${titleStyle.fontSize} ${titleStyle.fontFamily}`;
    // Use one shared line of type, so wrapping and different titles never resize the step.
    const ink = titleContext.measureText('Ag');
    const height = eyebrow.getBoundingClientRect().height + parseFloat(getComputedStyle(eyebrow).marginBottom) + ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent;
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
    svg.style.height = `${height}px`;
    svg.style.width = `${height * box.width / box.height}px`;
    number.style.paddingTop = `${Math.max(0, top - header.getBoundingClientRect().top)}px`;
  };
  const observer = new ResizeObserver(align);
  observer.observe(header.querySelector('.stage-heading'));
  document.fonts.addEventListener('loadingdone', align);
  align();
}
