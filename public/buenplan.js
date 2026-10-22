const offerGrid = document.querySelector('#offer-grid');
const offerDialog = document.querySelector('#offer-dialog');
const categoryFilters = document.querySelector('#category-filters');
const categoryShowcase = document.querySelector('#category-showcase');
const featuredTrack = document.querySelector('#featured-track');
const loadMoreButton = document.querySelector('#load-more');
const sortSelect = document.querySelector('#offer-sort');
const backToTop = document.querySelector('#back-to-top');
const localCanjesKey = 'buenplan-canjes';
const PAGE_SIZE = 9;

const state = {
  view: 'offers',
  category: '',
  search: '',
  sort: 'default',
  visible: PAGE_SIZE,
  offers: [],
  allOffers: [],
  categories: [],
  user: null,
  redemptions: [],
  selectedOffer: null,
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function getCanjes() {
  try {
    const saved = JSON.parse(localStorage.getItem(localCanjesKey) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveCanje(canje) {
  const canjes = getCanjes();
  localStorage.setItem(localCanjesKey, JSON.stringify([canje, ...canjes.filter((item) => item.id !== canje.id)]));
}

/** Los canjes viven en el servidor; el navegador solo guarda una copia local. */
function rememberRedemption(redemption) {
  state.redemptions = [redemption, ...state.redemptions.filter((item) => item.code !== redemption.code)];
  saveCanje({ ...redemption, offer: state.selectedOffer });
}

async function api(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'No se pudo completar la solicitud.');
  return payload;
}

async function loadOffers() {
  offerGrid.setAttribute('aria-busy', 'true');
  const parameters = new URLSearchParams();
  if (state.category) parameters.set('category', state.category);
  if (state.search) parameters.set('search', state.search);
  try {
    const [offers, categories] = await Promise.all([
      api(`/api/offers?${parameters}`),
      api('/api/offers/categories'),
    ]);
    state.offers = sortOffers(offers);
    state.allOffers = offers;
    state.categories = categories;
    renderCategories();
    renderCategoryShowcase();
    renderFeatured();
    renderOffers();
    document.querySelector('#fact-offers').textContent = categories.reduce((sum, item) => sum + item.count, 0);
    document.querySelector('#fact-categories').textContent = categories.length;
  } catch (error) {
    offerGrid.innerHTML = `<div class="empty-results"><strong>No pudimos cargar los beneficios</strong><span>${escapeHtml(error.message)}</span></div>`;
    document.querySelector('#result-line').textContent = 'Vuelve a intentarlo en un momento.';
  } finally {
    offerGrid.setAttribute('aria-busy', 'false');
  }
}

function sortOffers(offers) {
  const list = [...offers];
  if (state.sort === 'az') return list.sort((a, b) => a.brand.localeCompare(b.brand, 'es'));
  if (state.sort === 'category') return list.sort((a, b) => a.category.localeCompare(b.category, 'es') || a.brand.localeCompare(b.brand, 'es'));
  if (state.sort === 'featured') return list.sort((a, b) => Number(b.featured) - Number(a.featured));
  return list.sort((a, b) => Number(b.featured) - Number(a.featured) || a.category.localeCompare(b.category, 'es'));
}

const brandsGrid = document.querySelector('#brands-grid');

async function loadBrands() {
  if (!brandsGrid) return;
  brandsGrid.setAttribute('aria-busy', 'false');
  try {
    const brands = await api('/api/offers/top?limit=6');
    brandsGrid.innerHTML = brands.length
      ? brands.map((brand, index) => `
        <article class="brand-card" data-offer-id="${escapeHtml(brand.id)}" tabindex="0" role="button">
          <div class="brand-card-top${index === 0 ? ' is-first' : ''}">
            <span class="brand-avatar" style="background:${escapeHtml(brand.brandColor)}">${escapeHtml(brand.brandInitials)}</span>
            <div>
              <strong>${escapeHtml(brand.brand)}</strong>
              <span>${escapeHtml(brand.category)} · ${escapeHtml(brand.location)}</span>
            </div>
            <b class="brand-rank">${index === 0 ? '★ Favorito' : `#${index + 1}`}</b>
          </div>
          <div class="brand-card-body">
            <h3>${escapeHtml(brand.title)}</h3>
            <p>${escapeHtml(brand.description)}</p>
            <div class="brand-card-foot">
              <span class="brand-redemptions"><b>${brand.redemptions}</b> ${brand.redemptions === 1 ? 'canje' : 'canjes'}</span>
              <span class="brand-discount">${escapeHtml(brand.discountLabel)}</span>
            </div>
          </div>
        </article>`).join('')
      : '<p class="brands-empty">Todavía no hay marcas publicadas.</p>';
  } catch (error) {
    brandsGrid.innerHTML = `<p class="brands-empty">${escapeHtml(error.message)}</p>`;
  }
}

brandsGrid.addEventListener('click', (event) => {
  const card = event.target.closest('[data-offer-id]');
  if (!card) return;
  const offer = state.offers.find((item) => item.id === card.dataset.offerId)
    || state.allOffers.find((item) => item.id === card.dataset.offerId);
  if (offer) openOffer(offer);
});

brandsGrid.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('[data-offer-id]');
  if (!card) return;
  event.preventDefault();
  const offer = state.allOffers.find((item) => item.id === card.dataset.offerId);
  if (offer) openOffer(offer);
});

function bestDiscountLabel(stats) {
  const parts = [];
  if (stats.maxDiscount > 0) parts.push(`${stats.maxDiscount}%`);
  if (stats.hasTwoForOne) parts.push('2x1');
  if (stats.hasFree) parts.push('gratis');
  return parts.length ? parts.join(', ') : 'descuentos reales';
}

async function loadStats() {
  try {
    const stats = await api('/api/stats');
    document.querySelector('#fact-redemptions').textContent = stats.redemptions ?? 0;
    document.querySelector('#stat-brands').textContent = stats.businesses ?? 0;
    document.querySelector('#stat-discount').textContent = `${stats.averageDiscount ?? 0}%`;
    document.querySelector('#stat-subscribers').textContent = stats.subscribers ?? 0;
    const best = bestDiscountLabel(stats);
    document.querySelector('#stat-discount').title = `En el catálogo hay ofertas de ${best}`;
    document.querySelector('#benefit-max-discount').textContent = best;
    document.querySelector('#plan-max-discount').textContent = best;
  } catch {
    document.querySelector('#fact-redemptions').textContent = '0';
  }
}

function renderCategoryShowcase() {
  if (!categoryShowcase) return;
  categoryShowcase.setAttribute('aria-busy', 'false');
  const byCategory = new Map();
  for (const offer of state.allOffers) if (!byCategory.has(offer.category)) byCategory.set(offer.category, offer);
  const tiles = state.categories
    .filter((item) => byCategory.has(item.category))
    .slice(0, 8)
    .map(({ category, count }) => {
      const offer = byCategory.get(category);
      return `<button class="category-tile" type="button" data-category-tile="${escapeHtml(category)}">
        <img src="${escapeHtml(offer.image_url)}" alt="" loading="lazy">
        <b>${count} ${count === 1 ? 'beneficio' : 'beneficios'}</b>
        <strong>${escapeHtml(category)}</strong>
        <span>Ver descuentos →</span>
      </button>`;
    });
  categoryShowcase.innerHTML = tiles.length ? tiles.join('') : '<p class="category-showcase-empty">Pronto habrá más categorías disponibles.</p>';
}

function renderFeatured() {
  if (!featuredTrack) return;
  const featured = state.allOffers.filter((offer) => offer.featured).slice(0, 8);
  const list = featured.length ? featured : state.allOffers.slice(0, 8);
  featuredTrack.innerHTML = list.length
    ? list.map((offer) => `
      <article class="featured-card" data-offer-id="${escapeHtml(offer.id)}" tabindex="0" role="button">
        <div class="featured-photo">
          <img src="${escapeHtml(offer.image_url)}" alt="${escapeHtml(offer.brand)}" loading="lazy">
          <span class="offer-badge">${escapeHtml(offer.discount_label)}</span>
        </div>
        <div class="featured-copy">
          <div class="offer-brand-row"><span class="brand-avatar" style="background:${escapeHtml(offer.brand_color)}">${escapeHtml(offer.brand_initials)}</span><span class="offer-brand">${escapeHtml(offer.brand)}</span><span class="offer-category">${escapeHtml(offer.category)}</span></div>
          <h3>${escapeHtml(offer.title)}</h3>
          <p>${escapeHtml(offer.description)}</p>
          <div class="featured-foot"><span>⌖ ${escapeHtml(offer.location)}</span><b>Activar →</b></div>
        </div>
      </article>`).join('')
    : '<p class="featured-empty">Todavía no hay destacados publicados.</p>';
}

async function loadCurrentUser() {
  try {
    state.user = await api('/api/users/me');
    renderUser();
    await loadRedemptions();
  } catch {
    document.querySelector('#current-user-name').textContent = 'Invitado';
  }
}

async function loadRedemptions() {
  try {
    state.redemptions = await api('/api/redemptions');
  } catch {
    // Sin conexión con la API se muestran los canjes guardados en el navegador.
    state.redemptions = getCanjes();
  }
  updateRedemptionCount();
}

function updateRedemptionCount() {
  document.querySelector('#redemption-count').textContent = state.redemptions.length;
}

function renderUser() {
  const user = state.user;
  const isGuest = !user || user.guest;
  document.querySelector('#current-user-name').textContent = isGuest ? 'Invitado' : (user.displayName || user.username);
  document.querySelector('#user-avatar').textContent = isGuest ? '?' : (user.displayName || user.username).trim().charAt(0).toUpperCase();
  const action = document.querySelector('#user-action');
  action.textContent = isGuest ? 'Entrar' : 'Salir';
  action.dataset.mode = isGuest ? 'login' : 'logout';
}

function openAuthDialog() {
  const dialog = document.querySelector('#auth-dialog');
  const loggedOut = state.user && !state.user.guest;
  dialog.querySelector('#user-login-note').textContent = '';
  dialog.querySelector('#user-register-note').textContent = '';
  dialog.querySelector('#auth-title').textContent = loggedOut ? 'Tu cuenta' : 'Entra a BuenPlan';
  dialog.querySelector('.auth-dialog-copy').hidden = loggedOut;
  dialog.querySelector('.auth-tabs').hidden = loggedOut;
  dialog.querySelector('#user-login-form').classList.toggle('is-hidden', loggedOut);
  dialog.querySelector('#user-register-form').classList.add('is-hidden');
  document.querySelector('#user-logout').classList.toggle('is-hidden', !loggedOut);
  dialog.showModal();
}

document.querySelector('#user-action').addEventListener('click', async (event) => {
  if (event.currentTarget.dataset.mode === 'logout') {
    await api('/api/users/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    state.redemptions = [];
    renderUser();
    updateRedemptionCount();
    showToast('Cerraste sesión.');
    if (state.view === 'redemptions') setView('offers');
    return;
  }
  openAuthDialog();
});

document.querySelector('#user-tab-login').addEventListener('click', () => switchUserTab('login'));
document.querySelector('#user-tab-register').addEventListener('click', () => switchUserTab('register'));

function switchUserTab(which) {
  const isLogin = which === 'login';
  document.querySelector('#user-tab-login').classList.toggle('is-active', isLogin);
  document.querySelector('#user-tab-register').classList.toggle('is-active', !isLogin);
  document.querySelector('#user-login-form').classList.toggle('is-hidden', !isLogin);
  document.querySelector('#user-register-form').classList.toggle('is-hidden', isLogin);
}

async function submitUserAuth(formId, noteId, endpoint, payload) {
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
    state.user = result;
    renderUser();
    await loadRedemptions();
    form.reset();
    document.querySelector('#auth-dialog').close();
    showToast(`Hola, ${result.displayName || result.username}.`);
  } catch (error) {
    note.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

document.querySelector('#user-login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  submitUserAuth('#user-login-form', '#user-login-note', '/api/users/login', data);
});

document.querySelector('#user-register-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  submitUserAuth('#user-register-form', '#user-register-note', '/api/users/register', data);
});

document.querySelector('#user-logout').addEventListener('click', async () => {
  await api('/api/users/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  state.redemptions = [];
  renderUser();
  updateRedemptionCount();
  document.querySelector('#auth-dialog').close();
  showToast('Cerraste sesión.');
});

document.querySelector('#auth-close').addEventListener('click', () => document.querySelector('#auth-dialog').close());

function renderCategories() {
  const total = state.categories.reduce((sum, item) => sum + item.count, 0);
  const filters = [{ category: '', count: total }, ...state.categories.map((item) => ({ category: item.category, count: item.count }))];
  categoryFilters.innerHTML = filters.map(({ category, count }) => `
    <button class="category-chip${state.category === category ? ' is-active' : ''}" data-category="${escapeHtml(category)}" type="button">
      ${category ? escapeHtml(category) : 'Todos'} <span>${count}</span>
    </button>`).join('');
}

function renderOffers() {
  const marketingSections = ['#hero', '.quick-facts', '.stats-band', '#beneficios', '#categorias', '#destacados', '#como-funciona', '#planes', '#destacadas', '#preguntas', '.closing-banner', '.catalog-toolbar'];
  marketingSections.forEach((selector) => document.querySelector(selector)?.classList.toggle('view-hidden', state.view !== 'offers'));
  document.querySelector('#offers-title').innerHTML = state.view === 'offers' ? 'Buenos planes, <em>mejor precio.</em>' : 'Tus beneficios <em>guardados.</em>';
  document.querySelector('#offers-description').textContent = state.view === 'offers'
    ? 'Elige algo rico, algo nuevo o simplemente algo para ti.'
    : state.user && state.user.guest
      ? 'Aquí tienes los códigos que activaste en este dispositivo.'
      : 'Aquí tienes los códigos que activaste con tu cuenta.';

  const title = state.view === 'offers' ? 'Buenos planes, mejor precio.' : 'Tus canjes';
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('is-active', button.dataset.view === state.view));

  if (state.view === 'redemptions') {
    const canjes = state.redemptions;
    document.querySelector('#result-line').textContent = `${canjes.length} ${canjes.length === 1 ? 'beneficio activado' : 'beneficios activados'}`;
    document.querySelector('#offers-title').setAttribute('aria-label', title);
    offerGrid.innerHTML = canjes.length
      ? `<div class="redemptions-view">${canjes.map(redemptionMarkup).join('')}</div>`
      : `<div class="empty-results"><strong>Aún no has activado ningún beneficio</strong><span>${state.user && state.user.guest ? 'Cuando encuentres un buen plan, activa el código y guárdalo aquí.' : 'Cuando encuentres un buen plan, activa el código y aparecerá aquí.'}</span></div>`;
    loadMoreButton.hidden = true;
  } else {
    const resultCount = state.offers.length;
    const visible = state.offers.slice(0, state.visible);
    const catalogIsEmpty = state.allOffers.length === 0;
    document.querySelector('#result-line').textContent = catalogIsEmpty
      ? 'Pronto habrá nuevos beneficios'
      : `${resultCount} ${resultCount === 1 ? 'beneficio disponible' : 'beneficios disponibles'}`;
    offerGrid.innerHTML = resultCount
      ? visible.map(offerMarkup).join('')
      : catalogIsEmpty
        ? '<div class="empty-results"><strong>Todavía no hay beneficios publicados</strong><span>Los negocios están preparando sus ofertas. Vuelve en unos días o entra al panel para publicar la tuya.</span><a class="hero-button" href="/negocios.html">Publicar mi beneficio <span aria-hidden="true">→</span></a></div>'
        : '<div class="empty-results"><strong>No encontramos ese plan</strong><span>Prueba otra categoría o una búsqueda distinta.</span></div>';
    loadMoreButton.hidden = visible.length >= resultCount;
  }
  updateRedemptionCount();
}

function offerMarkup(offer, index) {
  return `<article class="offer-card" style="animation-delay:${Math.min(index * 35, 210)}ms">
    <div class="offer-photo">
      <img src="${escapeHtml(offer.image_url)}" alt="${escapeHtml(offer.brand)}" loading="lazy">
      ${offer.featured ? '<span class="featured-label"><span aria-hidden="true">✳</span> FAVORITO</span>' : ''}
      <span class="offer-badge">${escapeHtml(offer.discount_label)}</span>
    </div>
    <div class="offer-copy">
      <div class="offer-brand-row"><span class="brand-avatar" style="background:${escapeHtml(offer.brand_color)}">${escapeHtml(offer.brand_initials)}</span><span class="offer-brand">${escapeHtml(offer.brand)}</span><span class="offer-category">${escapeHtml(offer.category)}</span></div>
      <h3>${escapeHtml(offer.title)}</h3>
      <p>${escapeHtml(offer.description)}</p>
      <div class="offer-card-bottom"><span class="offer-location">⌖ &nbsp;${escapeHtml(offer.location)}</span><button class="offer-open" data-offer-id="${escapeHtml(offer.id)}" type="button">Ver beneficio <span aria-hidden="true">→</span></button></div>
    </div>
  </article>`;
}

function redemptionMarkup(canje) {
  const offer = canje.offer || {};
  return `<article class="redemption-card">
    <span class="brand-avatar" style="background:${escapeHtml(offer.brand_color || '#eaf0e8')}">${escapeHtml(offer.brand_initials || 'BP')}</span>
    <div class="redemption-copy"><strong>${escapeHtml(offer.brand || 'BuenPlan')}</strong><span>${escapeHtml(offer.title || 'Beneficio guardado')}</span></div>
    <span class="redemption-code">${escapeHtml(canje.code)}</span>
  </article>`;
}

function showCanjeResult(canje) {
  document.querySelector('#redeem-code').textContent = canje.code;
  document.querySelector('#redeem-result').hidden = false;
  const button = document.querySelector('#redeem-button');
  button.disabled = true;
  button.innerHTML = 'Beneficio activado <span aria-hidden="true">✓</span>';
}

function openOffer(offer) {
  state.selectedOffer = offer;
  registerView(offer.id);
  document.querySelector('#dialog-image').src = offer.image_url;
  document.querySelector('#dialog-image').alt = offer.brand;
  document.querySelector('#dialog-discount').textContent = offer.discount_label;
  document.querySelector('#dialog-avatar').textContent = offer.brand_initials;
  document.querySelector('#dialog-avatar').style.background = offer.brand_color;
  document.querySelector('#dialog-brand').textContent = offer.brand;
  document.querySelector('#dialog-location').textContent = offer.location;
  document.querySelector('#dialog-category').textContent = offer.category;
  document.querySelector('#dialog-title').textContent = offer.title;
  document.querySelector('#dialog-description').textContent = offer.description;
  document.querySelector('#dialog-perks').innerHTML = [
    `Ahorras ${offer.discount_label} en ${offer.brand}.`,
    `Válido en ${offer.location}.`,
    'Código único e ilimitado hasta su vencimiento.',
  ].map((perk) => `<li>${escapeHtml(perk)}</li>`).join('');
  document.querySelector('#dialog-terms').textContent = offer.terms;
  document.querySelector('#dialog-expiry').textContent = `Vigente hasta el ${new Intl.DateTimeFormat('es', { dateStyle: 'long' }).format(new Date(`${offer.expires_at}T12:00:00`))}.`;
  document.querySelector('#dialog-error').textContent = '';
  document.querySelector('#redeem-result').hidden = true;
  const button = document.querySelector('#redeem-button');
  button.disabled = false;
  button.innerHTML = 'Obtener mi beneficio <span aria-hidden="true">→</span>';
  const previous = state.redemptions.find((item) => item.offerId === offer.id);
  if (previous) showCanjeResult(previous);
  offerDialog.showModal();
}

const countedViews = new Set();
function registerView(offerId) {
  if (!offerId || countedViews.has(offerId)) return;
  countedViews.add(offerId);
  api(`/api/offers/${encodeURIComponent(offerId)}/view`, { method: 'POST' }).catch(() => {});
}

function setView(view, scroll = true) {
  state.view = view;
  renderOffers();
  if (!scroll) return;
  if (view === 'offers') document.querySelector('#ofertas').scrollIntoView({ behavior: 'smooth', block: 'start' });
  else window.scrollTo({ top: 0, behavior: 'smooth' });
}

categoryFilters.addEventListener('click', (event) => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  state.category = button.dataset.category;
  state.view = 'offers';
  state.visible = PAGE_SIZE;
  loadOffers();
});

categoryShowcase.addEventListener('click', (event) => {
  const tile = event.target.closest('[data-category-tile]');
  if (!tile) return;
  state.category = tile.dataset.categoryTile;
  state.search = '';
  document.querySelector('#offer-search').value = '';
  state.view = 'offers';
  state.visible = PAGE_SIZE;
  loadOffers().then(() => document.querySelector('#ofertas').scrollIntoView({ behavior: 'smooth', block: 'start' }));
});

sortSelect.addEventListener('change', (event) => {
  state.sort = event.target.value;
  state.visible = PAGE_SIZE;
  state.offers = sortOffers(state.offers);
  renderOffers();
});

loadMoreButton.addEventListener('click', () => {
  state.visible += PAGE_SIZE;
  renderOffers();
});

featuredTrack.addEventListener('click', (event) => {
  const card = event.target.closest('[data-offer-id]');
  if (!card) return;
  const offer = state.allOffers.find((item) => item.id === card.dataset.offerId);
  if (offer) openOffer(offer);
});

featuredTrack.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('[data-offer-id]');
  if (!card) return;
  event.preventDefault();
  const offer = state.allOffers.find((item) => item.id === card.dataset.offerId);
  if (offer) openOffer(offer);
});

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
document.querySelectorAll('a[href^="#"]').forEach((link) => link.addEventListener('click', () => {
  if (state.view !== 'offers') setView('offers', false);
}));

let searchTimer;
document.querySelector('#offer-search').addEventListener('input', (event) => {
  window.clearTimeout(searchTimer);
  state.search = event.target.value.trim();
  state.view = 'offers';
  state.visible = PAGE_SIZE;
  searchTimer = window.setTimeout(loadOffers, 180);
});

offerGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-offer-id]');
  if (!button) return;
  const offer = state.offers.find((item) => item.id === button.dataset.offerId);
  if (offer) openOffer(offer);
});

document.querySelector('#dialog-close').addEventListener('click', () => offerDialog.close());
offerDialog.addEventListener('click', (event) => { if (event.target === offerDialog) offerDialog.close(); });

document.querySelector('#redeem-button').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (!state.selectedOffer) return;
  button.disabled = true;
  document.querySelector('#dialog-error').textContent = '';
  try {
    const redemption = await api('/api/redemptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offerId: state.selectedOffer.id }),
    });
    const savedCanje = { ...redemption, offer: state.selectedOffer };
    rememberRedemption(savedCanje);
    showCanjeResult(savedCanje);
    showToast(state.user && state.user.guest
      ? 'Listo. Crea una cuenta para no perder el código.'
      : 'Listo. Guarda tu código para usar el beneficio.');
  } catch (error) {
    document.querySelector('#dialog-error').textContent = error.message;
    button.disabled = false;
  }
});

document.querySelector('#copy-code').addEventListener('click', async () => {
  const code = document.querySelector('#redeem-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    showToast('Código copiado.');
  } catch {
    showToast(`Tu código es ${code}`);
  }
});

let toastTimer;
function showToast(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2800);
}

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

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && !offerDialog.open) {
    event.preventDefault();
    document.querySelector('#offer-search').focus();
  }
});

window.addEventListener('scroll', () => backToTop.classList.toggle('is-visible', window.scrollY > 700), { passive: true });
backToTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

document.querySelector('#subscribe-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = document.querySelector('#subscribe-email');
  const note = document.querySelector('#subscribe-note');
  const button = form.querySelector('button');
  const email = input.value.trim();
  if (!email) {
    note.textContent = 'Escribe tu correo para recibir las ofertas.';
    input.focus();
    return;
  }
  button.disabled = true;
  note.textContent = 'Guardando tu correo...';
  try {
    const result = await api('/api/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    note.textContent = result.alreadySubscribed
      ? `Ya estabas en la lista con ${email}.`
      : `¡Listo! Te avisaremos a ${email} cuando llegue un nuevo buen plan.`;
    input.value = '';
    showToast(result.alreadySubscribed ? 'Ya estás en la lista.' : 'Te suscribiste a las ofertas BuenPlan.');
  } catch (error) {
    note.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#footer-year').textContent = new Date().getFullYear();

loadCurrentUser();
loadStats();
loadBrands();
loadOffers();
