export function normalizeX(value) {
  const text = String(value || '').trim();
  const match = /^(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/?(?:\?[^\s]*)?$/.exec(text);
  const handle = match ? match[1] : text.replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? '@' + handle : null;
}
export function initBetaAccess(form) {
  const email = form.elements.email, x = form.elements.xAccount;
  const button = form.querySelector('#betaSubmit'), status = form.querySelector('#betaRequestStatus'), fallback = form.querySelector('#betaEmailFallback');
  let pending = false, sent = false;
  x.addEventListener('input', () => x.setCustomValidity(''));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (pending || sent) return;
    const handle = normalizeX(x.value);
    x.setCustomValidity(handle ? '' : 'Enter a valid X handle or profile link.');
    if (!form.reportValidity()) return;
    pending = true; button.disabled = true; button.textContent = 'SENDING…';
    status.textContent = ''; delete status.dataset.error; fallback.hidden = true;
    const from = email.value.trim();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/feedback', {method:'POST', headers:{'Content-Type':'application/json'}, signal:controller.signal,
        body:JSON.stringify({topic:'Pro access', from, xAccount:handle, website:form.elements.website.value})});
      if (!response.ok) { const error=await response.json().catch(()=>({})); throw new Error(error.error || (response.status === 429 ? 'Too many requests. Please wait a minute and try again.' : 'Your request could not be sent. Please try again or email it instead.')); }
      const result = await response.json();
      if (result.ok !== true) throw new Error('Your request could not be confirmed. Please try again.');
      sent = true; email.readOnly = true; x.readOnly = true; button.textContent = 'REQUEST SENT';
      status.textContent = 'Request received. Sean will review it and reply by email with your Pro password.';
    } catch (error) {
      button.disabled = false; button.textContent = 'REQUEST PRO ACCESS →';
      status.dataset.error = 'true'; status.textContent = error.name === 'AbortError' ? 'The request timed out. Please try again or email your request instead.' : error.message;
      fallback.href = 'mailto:sean@nana.works?subject=OutLoud%20Pro%20access&body=' + encodeURIComponent(`I'd like to request OutLoud Pro access.\n\nEmail: ${from}\nX: ${handle}`);
      fallback.hidden = false;
    } finally { clearTimeout(timeout); pending = false; status.focus(); }
  });
}
