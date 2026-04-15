/**
 * trouver-un-professionnel.js
 * DoctoNET — Client navigateur
 *
 * Appelle /api/search?nom=NOM (Cloudflare Pages Function)
 * Pagination via nextUrl retourné par l'API.
 */

(function () {
  'use strict';

  const API_PROXY = '/api/search';

  let allResults    = [];
  let displayedCount = 0;
  let nextUrl        = null;   // lien page suivante retourné par l'API

  const inputEl        = document.getElementById('location-input');
  const btnSearch      = document.getElementById('btn-search');
  const btnLoadMore    = document.getElementById('btn-load-more');
  const stateInitial   = document.getElementById('state-initial');
  const stateLoading   = document.getElementById('state-loading');
  const stateError     = document.getElementById('state-error');
  const stateNoResults = document.getElementById('state-no-results');
  const errorMsg       = document.getElementById('error-message');
  const resultsHeader  = document.getElementById('results-header');
  const resultsGrid    = document.getElementById('results-grid');
  const resultsCountEl = document.getElementById('results-count-num');
  const resultsLocEl   = document.getElementById('results-location-label');
  const loadMoreWrap   = document.getElementById('load-more-wrap');

  /* =====================================================================
     UTILITAIRES
     ===================================================================== */
  function showState(state) {
    [stateInitial, stateLoading, stateError, stateNoResults].forEach(el => el.style.display = 'none');
    resultsHeader.style.display = resultsGrid.style.display = loadMoreWrap.style.display = 'none';
    if (state === 'initial')    stateInitial.style.display   = 'block';
    if (state === 'loading')    stateLoading.style.display   = 'block';
    if (state === 'error')      stateError.style.display     = 'block';
    if (state === 'no-results') stateNoResults.style.display = 'block';
    if (state === 'results')  { resultsHeader.style.display  = 'flex'; resultsGrid.style.display = 'flex'; }
  }

  function showError(msg) { errorMsg.textContent = msg; showState('error'); }

  function initials(name) {
    const p = (name || '?').trim().split(/\s+/);
    return p.length >= 2 ? (p[0][0] + p[1][0]).toUpperCase() : (name || '?').slice(0, 2).toUpperCase();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* =====================================================================
     APPEL AU PROXY
     ===================================================================== */
  async function fetchProfessionals(nom) {
    const params = new URLSearchParams({ nom });
    const res = await fetch(`${API_PROXY}?${params}`);
    if (!res.ok) throw new Error(`Erreur serveur (${res.status}). Veuillez réessayer.`);
    const data = await res.json();
    if (data.error) throw new Error('L\'annuaire de santé est momentanément indisponible. Veuillez réessayer.');
    return data;
  }

  async function fetchNextPage(url) {
    const params = new URLSearchParams({ next: url });
    const res = await fetch(`${API_PROXY}?${params}`);
    if (!res.ok) throw new Error(`Erreur serveur (${res.status}).`);
    return await res.json();
  }

  /* =====================================================================
     RENDU
     ===================================================================== */
  function renderCard(pro, index) {
    const card = document.createElement('article');
    card.className = 'pro-card';
    card.setAttribute('role', 'listitem');
    card.style.animationDelay = `${Math.min(index * 40, 400)}ms`;

    card.innerHTML = `
      <div class="pro-card-top">
        <div class="pro-avatar" aria-hidden="true">${initials(pro.nom)}</div>
        <div class="pro-info">
          <div class="pro-name">${escapeHtml(pro.nom)}</div>
          <span class="pro-specialty">${escapeHtml(pro.specialite || '')}</span>
        </div>
      </div>
      <div class="pro-details">
        ${pro.adresse  ? `<span class="pro-detail-item">📍 ${escapeHtml(pro.adresse)}</span>` : ''}
        ${pro.telephone ? `<span class="pro-detail-item">📞 <a href="tel:${pro.telephone.replace(/\s/g,'')}">${escapeHtml(pro.telephone)}</a></span>` : ''}
        ${pro.email     ? `<span class="pro-detail-item">✉️ <a href="mailto:${escapeHtml(pro.email)}">${escapeHtml(pro.email)}</a></span>` : ''}
      </div>`;
    return card;
  }

  function appendResults(results, index0) {
    results.forEach((pro, i) => resultsGrid.appendChild(renderCard(pro, index0 + i)));
  }

  /* =====================================================================
     RECHERCHE
     ===================================================================== */
  async function search() {
    const nom = inputEl.value.trim();
    if (!nom) { inputEl.focus(); return; }
    if (nom.length < 2) { showError('Saisissez au moins 2 lettres du nom de famille.'); return; }

    showState('loading');
    allResults = []; displayedCount = 0; nextUrl = null;
    resultsGrid.innerHTML = '';

    try {
      const data = await fetchProfessionals(nom);
      allResults  = data.results || [];
      nextUrl     = data.nextUrl || null;

      if (!allResults.length) { showState('no-results'); return; }

      showState('results');
      resultsCountEl.textContent = data.total >= 9856 ? '9000+' : data.total || allResults.length;
      resultsLocEl.textContent   = `Résultats pour « ${nom} »`;
      appendResults(allResults, 0);
      displayedCount = allResults.length;
      loadMoreWrap.style.display = nextUrl ? 'block' : 'none';

      document.getElementById('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      showError(err.message || 'Une erreur est survenue. Veuillez réessayer.');
    }
  }

  /* =====================================================================
     CHARGER PLUS
     ===================================================================== */
  async function loadMore() {
    if (!nextUrl) return;
    btnLoadMore.disabled = true;
    btnLoadMore.textContent = '⏳ Chargement…';

    try {
      const data = await fetchNextPage(nextUrl);
      const newResults = data.results || [];
      nextUrl = data.nextUrl || null;

      appendResults(newResults, displayedCount);
      displayedCount += newResults.length;
      allResults = allResults.concat(newResults);

      loadMoreWrap.style.display = nextUrl ? 'block' : 'none';
    } catch (err) {
      showError(err.message || 'Erreur lors du chargement.');
    } finally {
      btnLoadMore.disabled = false;
      btnLoadMore.textContent = 'Afficher plus de résultats';
    }
  }

  /* =====================================================================
     EVENTS
     ===================================================================== */
  btnSearch.addEventListener('click', search);
  inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
  btnLoadMore.addEventListener('click', loadMore);

})();
