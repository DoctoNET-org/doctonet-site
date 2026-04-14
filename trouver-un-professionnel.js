/**
 * trouver-un-professionnel.js
 * DoctoNET — Client navigateur
 *
 * Appelle /api/search (Cloudflare Pages Function)
 * qui fait le relais vers l'API Annuaire Santé côté serveur.
 *
 * Rayon : 20 km — Pagination : 20 résultats/page
 */

(function () {
  'use strict';

  const RADIUS_KM = 20;
  const PAGE_SIZE = 20;
  const API_GEO   = 'https://api-adresse.data.gouv.fr/search/';
  const API_PROXY = '/api/search'; // Notre Cloudflare Pages Function

  let allResults = [], displayedCount = 0;
  let currentLat = null, currentLon = null, currentLabel = '';
  let selectedSpecialty = '';

  const inputEl        = document.getElementById('location-input');
  const btnSearch      = document.getElementById('btn-search');
  const btnGeo         = document.getElementById('btn-geo');
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
  const filterChips    = document.querySelectorAll('.filter-chip');

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
    return p.length >= 2 ? (p[0][0]+p[1][0]).toUpperCase() : (name||'?').slice(0,2).toUpperCase();
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* =====================================================================
     GÉOCODAGE
     ===================================================================== */
  async function geocode(query) {
    const res = await fetch(`${API_GEO}?q=${encodeURIComponent(query)}&limit=1`);
    if (!res.ok) throw new Error('Erreur de géocodage. Veuillez réessayer.');
    const data = await res.json();
    if (!data.features?.length) throw new Error('Lieu introuvable. Essayez un autre code postal ou ville.');
    const f = data.features[0];
    return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: f.properties.label || query };
  }

  /* =====================================================================
     APPEL AU PROXY
     ===================================================================== */
  async function fetchProfessionals(lat, lon, specialty) {
    const params = new URLSearchParams({
      lat: lat.toFixed(6),
      lon: lon.toFixed(6),
      km:  RADIUS_KM,
    });
    if (specialty) params.append('specialty', specialty);

    const res = await fetch(`${API_PROXY}?${params}`);
    if (!res.ok) throw new Error(`Erreur serveur (${res.status}). Veuillez réessayer.`);

    const data = await res.json();
    if (data.error && !data.results?.length) {
      throw new Error('L\'annuaire de santé est momentanément indisponible. Veuillez réessayer dans quelques instants.');
    }
    return data.results || [];
  }

  /* =====================================================================
     RENDU
     ===================================================================== */
  function renderCard(pro, index) {
    const card = document.createElement('article');
    card.className = 'pro-card';
    card.setAttribute('role', 'listitem');
    card.style.animationDelay = `${Math.min(index*40, 400)}ms`;

    const distText = pro.distance !== null && pro.distance !== undefined
      ? `<span class="pro-distance">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
             <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
           </svg>
           ${pro.distance < 1 ? '< 1 km' : pro.distance.toFixed(1)+' km'}
         </span>`
      : '';

    card.innerHTML = `
      <div class="pro-card-top">
        <div class="pro-avatar" aria-hidden="true">${initials(pro.fullName)}</div>
        <div class="pro-info">
          <div class="pro-name">${escapeHtml(pro.fullName)}</div>
          <span class="pro-specialty">${escapeHtml(pro.specialty)}</span>
        </div>
        ${distText}
      </div>
      <div class="pro-details">
        ${pro.addrFull ? `<span class="pro-detail-item">📍 ${escapeHtml(pro.addrFull)}</span>` : ''}
        ${pro.phone    ? `<span class="pro-detail-item">📞 <a href="tel:${pro.phone.replace(/\s/g,'')}">${escapeHtml(pro.phone)}</a></span>` : ''}
      </div>`;
    return card;
  }

  function renderPage() {
    const start = displayedCount;
    const slice = allResults.slice(start, start + PAGE_SIZE);
    slice.forEach((pro, i) => resultsGrid.appendChild(renderCard(pro, start + i)));
    displayedCount += slice.length;
    loadMoreWrap.style.display = displayedCount < allResults.length ? 'block' : 'none';
  }

  function renderResults(results, label) {
    allResults = results; displayedCount = 0; resultsGrid.innerHTML = '';
    if (!results.length) { showState('no-results'); return; }
    showState('results');
    resultsCountEl.textContent = results.length >= 200 ? '200+' : results.length;
    resultsLocEl.textContent   = `📍 ${label} · rayon ${RADIUS_KM} km`;
    renderPage();
    document.getElementById('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* =====================================================================
     RECHERCHE
     ===================================================================== */
  async function search() {
    const query = inputEl.value.trim();
    if (!query && currentLat === null) { inputEl.focus(); return; }
    showState('loading');
    try {
      if (query && query !== 'Ma position actuelle') {
        const geo = await geocode(query);
        currentLat = geo.lat; currentLon = geo.lon; currentLabel = geo.label;
      }
      renderResults(await fetchProfessionals(currentLat, currentLon, selectedSpecialty), currentLabel);
    } catch (err) { showError(err.message || 'Une erreur est survenue. Veuillez réessayer.'); }
  }

  /* =====================================================================
     GÉOLOCALISATION
     ===================================================================== */
  function useGeolocation() {
    if (!navigator.geolocation) { showError('Géolocalisation non disponible sur votre appareil.'); return; }
    showState('loading');
    btnGeo.disabled = true; btnGeo.textContent = '⏳ Localisation…';
    navigator.geolocation.getCurrentPosition(
      async pos => {
        btnGeo.disabled = false; btnGeo.textContent = '📍 Ma position';
        currentLat = pos.coords.latitude; currentLon = pos.coords.longitude;
        currentLabel = 'Votre position'; inputEl.value = 'Ma position actuelle';
        try { renderResults(await fetchProfessionals(currentLat, currentLon, selectedSpecialty), currentLabel); }
        catch (err) { showError(err.message || 'Impossible de récupérer les données.'); }
      },
      err => {
        btnGeo.disabled = false; btnGeo.textContent = '📍 Ma position';
        const msgs = {
          1: 'Géolocalisation refusée. Saisissez votre ville manuellement.',
          3: 'Localisation trop lente. Saisissez votre ville manuellement.'
        };
        showError(msgs[err.code] || 'Impossible d\'obtenir votre position.');
      },
      { timeout: 10000, maximumAge: 60000 }
    );
  }

  /* =====================================================================
     EVENTS
     ===================================================================== */
  filterChips.forEach(chip => chip.addEventListener('click', function () {
    filterChips.forEach(c => c.classList.remove('active'));
    this.classList.add('active');
    selectedSpecialty = this.dataset.specialty || '';
    if (currentLat !== null) { resultsGrid.innerHTML = ''; search(); }
  }));

  btnSearch.addEventListener('click', search);
  inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
  inputEl.addEventListener('input', () => {
    if (inputEl.value.trim() !== 'Ma position actuelle') { currentLat = currentLon = null; currentLabel = ''; }
  });
  btnGeo.addEventListener('click', useGeolocation);
  btnLoadMore.addEventListener('click', renderPage);

})();
