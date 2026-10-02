import { API, apiFetch, fmt, getToken, requireLogin } from './admin.js';

requireLogin();
const form = document.getElementById('upload-form');
const upload = document.getElementById('upload-button');
const refresh = document.getElementById('refresh-button');
const list = document.getElementById('photos-list');
const status = document.getElementById('gallery-status');
const feedback = document.getElementById('feedback');
let loaded = false;

function message(text, error = false) {
  feedback.textContent = text;
  feedback.classList.toggle('error', error);
}

async function request(path, options) {
  const res = await apiFetch(path, options);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error.slice(0, 300) : `request failed (${res.status})`);
  return body;
}

function button(text, action, danger = false) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = danger ? 'btn danger' : 'btn';
  el.textContent = text;
  el.addEventListener('click', action);
  return el;
}

function photoCard(photo) {
  const card = document.createElement('article');
  card.className = 'photo-card';
  const image = document.createElement('img');
  image.alt = photo.caption || 'photo';
  image.loading = 'lazy';
  if (typeof photo.url === 'string' && /^\/photos\/[^/]+$/.test(photo.url)) image.src = `${API}${photo.url}`;
  const info = document.createElement('div');
  info.className = 'photo-info';
  const caption = document.createElement('p');
  caption.className = 'photo-caption';
  caption.textContent = photo.caption || 'no caption';
  const date = document.createElement('p');
  date.className = 'photo-date';
  date.textContent = fmt(photo.date);
  const prompt = document.createElement('p');
  prompt.className = 'photo-confirm';
  prompt.textContent = 'delete this photo?';
  prompt.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'photo-actions';
  const remove = button('delete', () => {
    remove.hidden = true;
    prompt.hidden = false;
    confirm.hidden = cancel.hidden = false;
    cancel.focus();
  }, true);
  const cancel = button('cancel', () => {
    prompt.hidden = true;
    confirm.hidden = cancel.hidden = true;
    remove.hidden = false;
    remove.focus();
  });
  const confirm = button('delete photo', async () => {
    confirm.disabled = cancel.disabled = true;
    confirm.textContent = 'deleting…';
    try {
      await request(`/photos/${encodeURIComponent(photo.id)}`, { method: 'DELETE' });
      card.remove();
      if (!list.childElementCount) status.textContent = 'no photos yet. upload an image above.';
      message('photo deleted');
      refresh.focus();
    } catch (error) {
      message(`could not delete photo: ${error.message}. try again.`, true);
    } finally {
      confirm.disabled = cancel.disabled = false;
      confirm.textContent = 'delete photo';
    }
  }, true);
  confirm.hidden = cancel.hidden = true;
  actions.append(remove, confirm, cancel);
  info.append(caption, date, prompt, actions);
  card.append(image, info);
  return card;
}

async function loadPhotos() {
  refresh.disabled = true;
  refresh.textContent = 'loading…';
  list.setAttribute('aria-busy', 'true');
  status.textContent = 'loading photos…';
  try {
    const photos = await request('/photos');
    if (!Array.isArray(photos)) throw new Error('invalid gallery response');
    list.replaceChildren(...photos.map(photoCard));
    loaded = true;
    delete refresh.dataset.failed;
    status.textContent = photos.length ? '' : 'no photos yet. upload an image above.';
  } catch (error) {
    status.textContent = `could not load photos: ${error.message}.${loaded ? ' showing the last loaded photos.' : ''} use retry photos to try again.`;
    refresh.dataset.failed = 'true';
  } finally {
    list.setAttribute('aria-busy', 'false');
    refresh.disabled = false;
    refresh.textContent = refresh.dataset.failed ? 'retry photos' : 'refresh photos';
  }
}

refresh.addEventListener('click', () => {
  delete refresh.dataset.failed;
  loadPhotos();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  upload.disabled = true;
  for (const input of form.querySelectorAll('input')) input.disabled = true;
  upload.textContent = 'uploading…';
  message('uploading photo…');
  try {
    const data = new FormData();
    data.set('file', document.getElementById('photo-file').files[0]);
    data.set('caption', document.getElementById('photo-caption').value);
    const photo = await request('/photos', { method: 'POST', body: data });
    if (!photo?.id) throw new Error('invalid upload response');
    form.reset();
    list.append(photoCard(photo));
    message('photo uploaded');
    if (loaded) status.textContent = '';
    else await loadPhotos();
  } catch (error) {
    message(`could not upload photo: ${error.message}. try again.`, true);
  } finally {
    upload.disabled = false;
    for (const input of form.querySelectorAll('input')) input.disabled = false;
    upload.textContent = 'upload photo';
  }
});
if (getToken()) loadPhotos();
