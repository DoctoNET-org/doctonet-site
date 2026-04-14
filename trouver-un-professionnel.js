/**
 * trouver-un-professionnel.js
 * DoctoNET — Recherche de professionnels de santé
 *
 * Sources 100% gratuites, sans clé API :
 *  - Géocodage : api-adresse.data.gouv.fr  (BAN — Base Adresse Nationale)
 *  - Professionnels : gateway.api.esante.gouv.fr (Annuaire Santé DREES)
 *
 * Rayon de recherche : 20 km
 * Pagination : 20 résultats par page
 */

(function () {
  'use strict';

  /* =====================================================================
     CONFIG
     ===================================================================== */
  const RADIUS_KM   = 20;
  const PAGE_SIZE   = 20;
  const API_GEO     = 'https://api-adresse.data.gouv.fr/search/';
  const API_SANTE   = 'https://api.annuaire.sante.fr/fhir/v1/Practitioner';

  /* =====================================================================
     STATE
     ===================================================================== */
  let allResults    = [];
  let displayedCount = 0;
  let currentLat    = null;
  let currentLon    = null;
  let currentLabel  = '';
  let selectedSpecialty = '';

  /* =====================================================================
     ÉLÉMENTS DOM
     ===================================================================== */
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

  /**
   * Formule de Haversine — distance en km entre deux points GPS
   */
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function showState(state) {
    stateInitial.style.display   = 'none';
    stateLoading.style.display   = 'none';
    stateError.style.display     = 'none';
    stateNoResults.style.display = 'none';
    resultsHeader.style.display  = 'none';
    resultsGrid.style.display    = 'none';
    loadMoreWrap.style.display   = 'none';

    if (state === 'initial')    { stateInitial.style.display = 'block'; }
    if (state === 'loading')    { stateLoading.style.display = 'block'; }
    if (state === 'error')      { stateError.style.display   = 'block'; }
    if (state === 'no-results') { stateNoResults.style.display = 'block'; }
    if (state === 'results')    {
      resultsHeader.style.display = 'flex';
      resultsGrid.style.display   = 'flex';
    }
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    showState('error');
  }

  /**
   * Initiales pour l'avatar (2 lettres depuis le nom)
   */
  function initials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  /**
   * Délai d'animation décalé pour les cartes
   */
  function animDelay(index) {
    return Math.min(index * 40, 400);
  }

  /* =====================================================================
     GÉOCODAGE — api-adresse.data.gouv.fr
     ===================================================================== */
  async function geocode(query) {
    const url = `${API_GEO}?q=${encodeURIComponent(query)}&limit=1&type=municipality`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error('Erreur de géocodage');
    const data = await res.json();
    if (!data.features || data.features.length === 0) {
      throw new Error('Lieu introuvable. Essayez un autre code postal ou une autre ville.');
    }
    const feat = data.features[0];
    return {
      lat:   feat.geometry.coordinates[1],
      lon:   feat.geometry.coordinates[0],
      label: feat.properties.label || query
    };
  }

  /* =====================================================================
     API ANNUAIRE SANTÉ — gateway.api.esante.gouv.fr
     ===================================================================== */
  async function fetchProfessionals(lat, lon, specialty) {
    // Mapping spécialité → libellé partiel pour l'API
    const specialtyMap = {
      'Médecin':          'Médecin',
      'Infirmier':        'Infirmier',
      'Kinésithérapeute': 'Masseur',
      'Pharmacien':       'Pharmacien',
      'Dentiste':         'Chirurgien-Dentiste',
      'Psychiatre':       'Psychiatre',
    };

    const params = new URLSearchParams({
      '_near':   `${lat}|${lon}|${RADIUS_KM}|km`,
      '_count':  '200',
      '_format': 'json',
    });

    if (specialty && specialtyMap[specialty]) {
      params.append('qualification', specialtyMap[specialty]);
    }

    const url = `${API_SANTE}?${params.toString()}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/fhir+json' }
    });

    if (!res.ok) {
      // Fallback : PractitionerRole avec include
      return await fetchProfessionalsFallback(lat, lon, specialty);
    }

    const data = await res.json();
    const results = parseFHIR(data, lat, lon);

    // Si pas de résultats FHIR directs, tenter le fallback
    if (results.length === 0) {
      return await fetchProfessionalsFallback(lat, lon, specialty);
    }
    return results;
  }

  async function fetchProfessionalsFallback(lat, lon, specialty) {
    const baseUrl = 'https://api.annuaire.sante.fr/fhir/v1/PractitionerRole';
    const params = new URLSearchParams({
      'location.near': `${lat}|${lon}|${RADIUS_KM}|km`,
      '_include':      'PractitionerRole:practitioner',
      '_count':        '200',
      '_format':       'json',
    });

    const specialtyMap = {
      'Médecin':          'SM26',
      'Infirmier':        'SM60',
      'Kinésithérapeute': 'SM40',
      'Pharmacien':       'SM80',
      'Dentiste':         'SM55',
      'Psychiatre':       'SM26',
    };

    if (specialty && specialtyMap[specialty]) {
      params.append('specialty', specialtyMap[specialty]);
    }

    const res = await fetch(`${baseUrl}?${params.toString()}`, {
      headers: { 'Accept': 'application/fhir+json' }
    });

    if (!res.ok) {
      throw new Error(
        `L'annuaire de santé est momentanément indisponible (${res.status}). ` +
        `Veuillez réessayer dans quelques instants.`
      );
    }

    const data = await res.json();
    return parseFHIRRoles(data, lat, lon);
  }

  /**
   * Parse une réponse FHIR Bundle de Practitioners
   */
  function parseFHIR(bundle, refLat, refLon) {
    if (!bundle.entry) return [];
    return bundle.entry
      .map(e => {
        const p = e.resource;
        if (!p || p.resourceType !== 'Practitioner') return null;

        const namePart = p.name && p.name[0];
        const family   = namePart?.family || '';
        const given    = (namePart?.given || []).join(' ');
        const fullName = [given, family].filter(Boolean).join(' ') || 'Professionnel de santé';

        // Qualification = spécialité
        const qual = p.qualification && p.qualification[0];
        const specialty = qual?.code?.text || qual?.code?.coding?.[0]?.display || 'Professionnel de santé';

        // Adresse
        const addr = p.address && p.address[0];
        const city = addr?.city || '';
        const postalCode = addr?.postalCode || '';
        const addrLine = addr?.line?.[0] || '';
        const addrFull = [addrLine, postalCode, city].filter(Boolean).join(', ');

        // Coordonnées GPS (si disponibles dans l'extension)
        let proLat = null, proLon = null;
        if (addr?.extension) {
          const geoExt = addr.extension.find(x => x.url && x.url.includes('geolocation'));
          if (geoExt && geoExt.extension) {
            const latExt = geoExt.extension.find(x => x.url === 'latitude');
            const lonExt = geoExt.extension.find(x => x.url === 'longitude');
            if (latExt) proLat = parseFloat(latExt.valueDecimal);
            if (lonExt) proLon = parseFloat(lonExt.valueDecimal);
          }
        }

        const distance = (proLat && proLon)
          ? haversine(refLat, refLon, proLat, proLon)
          : null;

        // Télécom
        const telecom = p.telecom || [];
        const phone   = telecom.find(t => t.system === 'phone')?.value || '';
        const email   = telecom.find(t => t.system === 'email')?.value || '';

        return { fullName, specialty, addrFull, city, postalCode, phone, email, distance };
      })
      .filter(Boolean)
      .filter(p => p.distance === null || p.distance <= RADIUS_KM)
      .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
  }

  /**
   * Parse une réponse FHIR Bundle de PractitionerRoles
   */
  function parseFHIRRoles(bundle, refLat, refLon) {
    if (!bundle.entry) return [];

    const practitioners = {};
    const roles = [];

    bundle.entry.forEach(e => {
      const r = e.resource;
      if (!r) return;
      if (r.resourceType === 'Practitioner') {
        practitioners[r.id] = r;
      }
      if (r.resourceType === 'PractitionerRole') {
        roles.push(r);
      }
    });

    return roles.map(role => {
      const practId = role.practitioner?.reference?.split('/').pop();
      const pract   = practitioners[practId];

      // Nom
      let fullName = 'Professionnel de santé';
      if (pract && pract.name && pract.name[0]) {
        const n = pract.name[0];
        fullName = [((n.given || []).join(' ')), n.family].filter(Boolean).join(' ');
      }

      // Spécialité
      const spec = role.specialty?.[0]?.coding?.[0]?.display
        || role.specialty?.[0]?.text
        || 'Professionnel de santé';

      // Localisation
      const loc = role.location?.[0];
      const addr = loc?.address || pract?.address?.[0];
      const addrLine   = addr?.line?.[0] || '';
      const city       = addr?.city || '';
      const postalCode = addr?.postalCode || '';
      const addrFull   = [addrLine, postalCode, city].filter(Boolean).join(', ');

      // GPS
      let proLat = null, proLon = null;
      if (addr?.extension) {
        const geoExt = addr.extension.find(x => x.url && x.url.includes('geolocation'));
        if (geoExt?.extension) {
          const latExt = geoExt.extension.find(x => x.url === 'latitude');
          const lonExt = geoExt.extension.find(x => x.url === 'longitude');
          if (latExt) proLat = parseFloat(latExt.valueDecimal);
          if (lonExt) proLon = parseFloat(lonExt.valueDecimal);
        }
      }

      const distance = (proLat && proLon)
        ? haversine(refLat, refLon, proLat, proLon)
        : null;

      // Téléphone
      const telecom = role.telecom || pract?.telecom || [];
      const phone = telecom.find(t => t.system === 'phone')?.value || '';

      return { fullName, specialty: spec, addrFull, city, postalCode, phone, email: '', distance };
    })
    .filter(p => p.distance === null || p.distance <= RADIUS_KM)
    .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
  }

  /* =====================================================================
     RENDU DES CARTES
     ===================================================================== */
  function renderCard(pro, index) {
    const card = document.createElement('article');
    card.className = 'pro-card';
    card.setAttribute('role', 'listitem');
    card.style.animationDelay = `${animDelay(index)}ms`;

    const distText = pro.distance !== null
      ? `<span class="pro-distance">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
             <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
           </svg>
           ${pro.distance < 1 ? '< 1 km' : pro.distance.toFixed(1) + ' km'}
         </span>`
      : '';

    const phoneHtml = pro.phone
      ? `<span class="pro-detail-item">📞 <a href="tel:${pro.phone.replace(/\s/g, '')}">${pro.phone}</a></span>`
      : '';

    const addrHtml = pro.addrFull
      ? `<span class="pro-detail-item">📍 ${pro.addrFull}</span>`
      : pro.city
        ? `<span class="pro-detail-item">📍 ${pro.city}</span>`
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
        ${addrHtml}
        ${phoneHtml}
      </div>
    `;

    return card;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderPage() {
    const slice = allResults.slice(displayedCount, displayedCount + PAGE_SIZE);
    slice.forEach((pro, i) => {
      resultsGrid.appendChild(renderCard(pro, displayedCount + i));
    });
    displayedCount += slice.length;

    if (displayedCount < allResults.length) {
      loadMoreWrap.style.display = 'block';
    } else {
      loadMoreWrap.style.display = 'none';
    }
  }

  function renderResults(results, locationLabel) {
    allResults     = results;
    displayedCount = 0;
    resultsGrid.innerHTML = '';

    if (results.length === 0) {
      showState('no-results');
      return;
    }

    showState('results');
    resultsCountEl.textContent = results.length > 199 ? '200+' : results.length;
    resultsLocEl.textContent   = `📍 ${locationLabel} · rayon ${RADIUS_KM} km`;

    renderPage();
    // Scroll doux vers les résultats
    document.getElementById('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* =====================================================================
     RECHERCHE PRINCIPALE
     ===================================================================== */
  async function search() {
    const query = inputEl.value.trim();
    if (!query && currentLat === null) {
      inputEl.focus();
      return;
    }

    showState('loading');

    try {
      // 1) Géocodage si on n'a pas déjà des coordonnées GPS directes
      if (query) {
        const geo = await geocode(query);
        currentLat   = geo.lat;
        currentLon   = geo.lon;
        currentLabel = geo.label;
      }

      // 2) Appel à l'Annuaire Santé
      const results = await fetchProfessionals(currentLat, currentLon, selectedSpecialty);
      renderResults(results, currentLabel);

    } catch (err) {
      showError(err.message || 'Une erreur est survenue. Veuillez réessayer.');
    }
  }

  /* =====================================================================
     GÉOLOCALISATION NAVIGATEUR
     ===================================================================== */
  function useGeolocation() {
    if (!navigator.geolocation) {
      showError('La géolocalisation n\'est pas disponible sur votre appareil.');
      return;
    }

    showState('loading');
    btnGeo.disabled = true;
    btnGeo.textContent = '⏳ Localisation…';

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        btnGeo.disabled = false;
        btnGeo.textContent = '📍 Ma position';

        currentLat   = pos.coords.latitude;
        currentLon   = pos.coords.longitude;
        currentLabel = 'Votre position';
        inputEl.value = 'Ma position actuelle';

        try {
          const results = await fetchProfessionals(currentLat, currentLon, selectedSpecialty);
          renderResults(results, currentLabel);
        } catch (err) {
          showError(err.message || 'Impossible de récupérer les données.');
        }
      },
      (err) => {
        btnGeo.disabled = false;
        btnGeo.textContent = '📍 Ma position';

        let msg = 'Impossible d\'obtenir votre position.';
        if (err.code === 1) msg = 'Vous avez refusé la géolocalisation. Saisissez votre ville manuellement.';
        if (err.code === 3) msg = 'La géolocalisation a pris trop de temps. Saisissez votre ville manuellement.';
        showError(msg);
      },
      { timeout: 10000, maximumAge: 60000 }
    );
  }

  /* =====================================================================
     FILTRES SPÉCIALITÉ
     ===================================================================== */
  filterChips.forEach(chip => {
    chip.addEventListener('click', function () {
      filterChips.forEach(c => c.classList.remove('active'));
      this.classList.add('active');
      selectedSpecialty = this.dataset.specialty || '';

      // Relance la recherche si des coordonnées sont déjà connues
      if (currentLat !== null) {
        resultsGrid.innerHTML = '';
        search();
      }
    });
  });

  /* =====================================================================
     EVENTS
     ===================================================================== */
  btnSearch.addEventListener('click', search);

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') search();
  });

  // Réinitialise les coordonnées GPS si l'utilisateur retape manuellement
  inputEl.addEventListener('input', function () {
    currentLat = null;
    currentLon = null;
    currentLabel = '';
  });

  btnGeo.addEventListener('click', useGeolocation);

  btnLoadMore.addEventListener('click', renderPage);

})();
