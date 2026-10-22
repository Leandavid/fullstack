const authSection = document.querySelector('#acceso');
const panel = document.querySelector('#panel');
const publishSection = document.querySelector('#publicar');
const offerForm = document.querySelector('#offer-form');
const manageList = document.querySelector('#manage-list');
let editingId = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function api(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'No se pudo completar la solicitud.');
  return payload;
}

function showToast(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('is-visible'), 2800);
}

/* ---------- Acceso ---------- */

function switchAuthTab(which) {
  const isLogin = which === 'login';
  document.querySelector('#tab-login').classList.toggle('is-active', isLogin);
  document.querySelector('#tab-register').classList.toggle('is-active', !isLogin);
  document.querySelector('#tab-login').setAttribute('aria-selected', String(isLogin));
  document.querySelector('#tab-register').setAttribute('aria-selected', String(!isLogin));
  document.querySelector('#login-form').classList.toggle('is-hidden', !isLogin);
  document.querySelector('#register-form').classList.toggle('is-hidden', isLogin);
}

document.querySelector('#tab-login').addEventListener('click', () => switchAuthTab('login'));
document.querySelector('#tab-register').addEventListener('click', () => switchAuthTab('register'));

async function submitAuthForm(formId, noteId, endpoint, payload) {
  const form = document.querySelector(formId);
  const button = form.querySelector('button');
  const note = document.querySelector(noteId);
  button.disabled = true;
  note.textContent = 'Un momento...';
  try {
    const result = await api(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    form.reset();
    note.textContent = '';
    showToast(`Listo, ${result.brand}. Ya puedes publicar.`);
    loadPanel();
  } catch (error) {
    note.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

document.querySelector('#login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  if (!data.brand || !data.password) {
    document.querySelector('#login-note').textContent = 'Escribe tu negocio y tu contraseña.';
    return;
  }
  submitAuthForm('#login-form', '#login-note', '/api/business/login', data);
});

document.querySelector('#register-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  if (!data.brand || !data.contact || !data.password) {
    document.querySelector('#register-note').textContent = 'Completa los tres campos.';
    return;
  }
  submitAuthForm('#register-form', '#register-note', '/api/business/register', data);
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  await api('/api/business/logout', { method: 'POST' }).catch(() => {});
  showSignedOut();
  showToast('Cerraste sesión.');
});

/* ---------- Panel ---------- */

function showSignedIn(business) {
  authSection.classList.add('is-hidden');
  panel.classList.remove('is-hidden');
  publishSection.classList.remove('is-hidden');
  document.querySelector('#session-brand').textContent = business.brand;
  document.querySelector('#session-avatar').textContent = business.brand.trim().charAt(0).toUpperCase() || 'N';
}

function showSignedOut() {
  authSection.classList.remove('is-hidden');
  panel.classList.add('is-hidden');
  publishSection.classList.add('is-hidden');
  document.querySelector('#session-brand').textContent = 'Negocios';
  document.querySelector('#session-avatar').textContent = 'N';
  cancelEditing();
}

function formatDate(value) {
  if (!value) return 'Sin fecha';
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('es', { dateStyle: 'long' }).format(parsed);
}

function renderManagedOffers(offers) {
  if (!offers.length) {
    manageList.innerHTML = '<p class="table-empty">Todavía no publicas ningún beneficio. Usa el formulario de abajo.</p>';
    return;
  }
  manageList.innerHTML = offers.map((offer) => `
    <article class="manage-card">
      <img src="${escapeHtml(offer.imageUrl)}" alt="" loading="lazy">
      <div class="manage-body">
        <div class="manage-top">
          <strong>${escapeHtml(offer.title)}</strong>
          <span class="brand-discount">${escapeHtml(offer.discountLabel)}</span>
        </div>
        <p class="manage-meta">${escapeHtml(offer.category)} · ${escapeHtml(offer.location)} · vigente hasta el ${escapeHtml(formatDate(offer.expiresAt))}</p>
        <div class="manage-stats">
          <span><b>${offer.views}</b> visitas</span>
          <span><b>${offer.redemptions}</b> canjes</span>
        </div>
      </div>
      <div class="manage-actions">
        <button class="plan-button" type="button" data-edit="${escapeHtml(offer.id)}">Editar</button>
        <button class="plan-button plan-button--danger" type="button" data-remove="${escapeHtml(offer.id)}">Quitar</button>
      </div>
    </article>`).join('');
}

async function loadPanel() {
  try {
    const data = await api('/api/business/overview');
    showSignedIn(data.business);
    document.querySelector('#biz-total-offers').textContent = data.totals.offers;
    document.querySelector('#biz-total-views').textContent = data.totals.views;
    document.querySelector('#biz-total-redemptions').textContent = data.totals.redemptions;
    document.querySelector('#panel-summary').textContent = data.business.verified
      ? `Perfil verificado. Contacto: ${data.business.contact}.`
      : `Contacto: ${data.business.contact || 'sin definir'}. Tu perfil aún no está verificado.`;
    renderManagedOffers(data.offers);
    loadPanel.lastOffers = data.offers;
  } catch (error) {
    showSignedOut();
  }
}

/* ---------- Publicar, editar y quitar ---------- */

function resetForm() {
  offerForm.reset();
  document.querySelector('#form-note').textContent = '';
}

function startEditing(id) {
  const offer = loadPanel.lastOffers.find((item) => item.id === id);
  if (!offer) return;
  editingId = id;
  offerForm.title.value = offer.title;
  offerForm.discountLabel.value = offer.discountLabel;
  offerForm.category.value = offer.category;
  offerForm.location.value = offer.location;
  offerForm.description.value = offer.description;
  offerForm.terms.value = offer.terms;
  offerForm.imageUrl.value = offer.imageUrl;
  offerForm.expiresAt.value = offer.expiresAt;
  document.querySelector('#form-kicker').textContent = 'EDITAR';
  document.querySelector('#form-title').innerHTML = 'Cambia lo que<br><em>quieras.</em>';
  document.querySelector('#offer-submit').innerHTML = 'Guardar cambios <span aria-hidden="true">→</span>';
  document.querySelector('#offer-cancel').classList.remove('is-hidden');
  publishSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditing() {
  editingId = null;
  offerForm.reset();
  document.querySelector('#form-kicker').textContent = 'PUBLICAR';
  document.querySelector('#form-title').innerHTML = 'Tu descuento,<br><em>en un minuto.</em>';
  document.querySelector('#offer-submit').innerHTML = 'Publicar beneficio <span aria-hidden="true">→</span>';
  document.querySelector('#offer-cancel').classList.add('is-hidden');
}

document.querySelector('#offer-cancel').addEventListener('click', cancelEditing);

manageList.addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-edit]');
  const removeButton = event.target.closest('[data-remove]');

  if (editButton) {
    startEditing(editButton.dataset.edit);
    return;
  }

  if (removeButton) {
    const id = removeButton.dataset.remove;
    if (!window.confirm('¿Quitar este beneficio del catálogo? Dejará de aparecer para los usuarios.')) return;
    removeButton.disabled = true;
    try {
      await api(`/api/business/offers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      showToast('Beneficio retirado del catálogo.');
      if (editingId === id) cancelEditing();
      loadPanel();
    } catch (error) {
      showToast(error.message);
      removeButton.disabled = false;
    }
  }
});

offerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#offer-submit');
  const note = document.querySelector('#form-note');
  const data = Object.fromEntries(new FormData(offerForm).entries());
  const required = ['title', 'discountLabel', 'location', 'description', 'terms', 'imageUrl', 'expiresAt'];
  if (required.some((key) => !String(data[key] || '').trim())) {
    note.textContent = 'Completa todos los campos obligatorios.';
    return;
  }

  button.disabled = true;
  note.textContent = editingId ? 'Guardando...' : 'Publicando...';
  try {
    if (editingId) {
      await api(`/api/business/offers/${encodeURIComponent(editingId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      showToast('Cambios guardados.');
      cancelEditing();
    } else {
      const result = await api('/api/business/offers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      showToast(`"${result.brand}" ya está en el catálogo.`);
      resetForm();
    }
    loadPanel();
  } catch (error) {
    note.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

/* ---------- Navegación ---------- */

const mobileMenuButton = document.querySelector('#mobile-menu-button');
mobileMenuButton.addEventListener('click', () => {
  const nav = document.querySelector('.main-nav');
  const isOpen = nav.classList.toggle('is-open');
  mobileMenuButton.setAttribute('aria-expanded', String(isOpen));
});
document.querySelectorAll('.main-nav a, .main-nav button').forEach((item) => item.addEventListener('click', () => {
  document.querySelector('.main-nav').classList.remove('is-open');
  mobileMenuButton.setAttribute('aria-expanded', 'false');
}));

document.querySelector('#footer-year').textContent = new Date().getFullYear();
loadPanel();