// SPDX-FileCopyrightText: 2026 Dédale Solutions
// SPDX-License-Identifier: EUPL-1.2

'use strict';

/*
 * Console ARC : application monopage sans dépendance.
 * Toutes les données issues des API sont affichées via textContent (jamais innerHTML).
 * Le jeton JWT d'arc-auth est conservé dans sessionStorage (effacé à la fermeture de l'onglet).
 */

const SESSION_KEY = 'arc-console-session';
const WRITE_ROLES = ['ARC_ADMIN', 'ARC_PUBLISHER'];
const SCOPES = ['TIER0', 'TIER1', 'TIER2'];

const main = document.getElementById('main');
const nav = document.getElementById('nav');
const topbar = document.getElementById('topbar');
const messageBox = document.getElementById('message');

let session = null;
let currentView = null;

// --- Utilitaires DOM -------------------------------------------------------------------------

function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') {
      element.addEventListener(name.slice(2), value);
    } else if (value === true) {
      element.setAttribute(name, '');
    } else {
      element.setAttribute(name, value);
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

let messageTimer = null;

function show(message, kind = 'error') {
  clearTimeout(messageTimer);
  messageBox.textContent = message;
  messageBox.className = kind;
  messageBox.hidden = false;
  if (kind === 'ok') messageTimer = setTimeout(clearMessage, 5000);
}

function clearMessage() {
  clearTimeout(messageTimer);
  messageBox.hidden = true;
  messageBox.textContent = '';
}

function render(...nodes) {
  main.replaceChildren(...nodes);
}

// --- Session et appels API -------------------------------------------------------------------

function decodeJwt(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(payload))));
  } catch {
    return {};
  }
}

function loadSession() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    if (stored && stored.token && stored.expiresAt > Date.now()) return stored;
  } catch {
    // session illisible : on repart d'une connexion
  }
  sessionStorage.removeItem(SESSION_KEY);
  return null;
}

function canWrite() {
  return session.roles.some((role) => WRITE_ROLES.includes(role));
}

async function login(username, password) {
  const response = await fetch('/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Identifiant ou mot de passe incorrect.');
  if (!response.ok) throw new Error(`Connexion impossible (HTTP ${response.status}).`);
  const data = await response.json();
  const claims = decodeJwt(data.access_token);
  session = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 300) * 1000,
    user: claims.sub || username,
    roles: Array.isArray(claims.roles) ? claims.roles : [],
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function logout(reason) {
  session = null;
  sessionStorage.removeItem(SESSION_KEY);
  showLogin();
  if (reason) show(reason);
}

/** Appelle product-manager (`pm`) ou identity-manager (`im`) avec le jeton courant. */
async function api(service, method, path, body) {
  if (!session || session.expiresAt <= Date.now()) {
    logout('Session expirée, reconnectez-vous.');
    throw new Error('session expirée');
  }
  const response = await fetch(`/api/${service}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) {
    logout('Session expirée, reconnectez-vous.');
    throw new Error('non authentifié');
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const detail = data && (data.message || data.error || data.detail);
    const reasons = {
      400: 'requête invalide',
      403: 'droits insuffisants',
      404: 'introuvable',
      409: 'élément déjà existant',
      502: 'service injoignable',
    };
    throw new Error(`${detail || reasons[response.status] || 'erreur'} (HTTP ${response.status})`);
  }
  return data;
}

/** Exécute une action, affiche son résultat et rafraîchit la vue. */
async function run(action, success) {
  clearMessage();
  try {
    await action();
    if (success) show(success, 'ok');
    await currentView();
  } catch (error) {
    if (session) show(error.message);
  }
}

// --- Composants ------------------------------------------------------------------------------

function table(columns, rows, empty) {
  if (rows.length === 0) return h('p', { class: 'empty box' }, empty);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', {}, c.label)))),
      h(
        'tbody',
        {},
        rows.map((row) => h('tr', {}, columns.map((c) => h('td', { class: c.mono ? 'mono' : undefined }, c.cell(row))))),
      ),
    ),
  );
}

function confirmThen(question, action) {
  return () => {
    if (window.confirm(question)) action();
  };
}

/** Champs de métadonnées d'un type de compte ; `read()` retourne l'objet typé ou lève une erreur. */
function metadataForm(type, values = {}) {
  const fields = (type && type.metadata) || [];
  const inputs = fields.map((field) => {
    const kind = field.type === 'NUMBER' ? 'number' : field.type === 'BOOLEAN' ? 'checkbox' : 'text';
    const input = h('input', { type: kind, name: field.name, step: kind === 'number' ? 'any' : undefined });
    const current = values[field.name];
    if (current !== undefined && current !== null) {
      if (kind === 'checkbox') input.checked = current === true;
      else input.value = String(current);
    }
    const label = h('label', { class: kind === 'checkbox' ? 'inline' : undefined }, `${field.name}${field.required ? ' *' : ''}`);
    if (kind === 'checkbox') label.prepend(input);
    else label.append(input);
    return { field, input, label };
  });
  return {
    element: h('div', { class: 'form-grid' }, inputs.map((i) => i.label)),
    read() {
      const result = {};
      for (const { field, input } of inputs) {
        if (field.type === 'BOOLEAN') {
          result[field.name] = input.checked;
        } else if (input.value.trim() !== '') {
          result[field.name] = field.type === 'NUMBER' ? Number(input.value) : input.value.trim();
        } else if (field.required) {
          throw new Error(`Le champ « ${field.name} » est obligatoire.`);
        }
      }
      return result;
    },
  };
}

// --- Vue : produits --------------------------------------------------------------------------

async function productsView() {
  const products = await api('pm', 'GET', '/products');
  const nodes = [
    h('h2', {}, 'Produits'),
    table(
      [
        { label: 'Nom', cell: (p) => p.name, mono: true },
        { label: 'Description', cell: (p) => p.description || '' },
        { label: 'Profils', cell: (p) => (p.profiles || []).map((x) => x.name).join(', ') || '—' },
        {
          label: '',
          cell: (p) =>
            canWrite()
              ? h('div', { class: 'actions' },
                  h('button', { type: 'button', class: 'secondary', onclick: () => profileForm(p) }, 'Ajouter un profil'),
                  h('button', {
                    type: 'button',
                    class: 'danger',
                    onclick: confirmThen(`Supprimer le produit ${p.name} ?`, () =>
                      run(() => api('pm', 'DELETE', `/products/${encodeURIComponent(p.name)}`), 'Produit supprimé.')),
                  }, 'Supprimer'))
              : '',
        },
      ],
      products,
      'Aucun produit.',
    ),
  ];
  if (canWrite()) {
    const form = h('form', { class: 'card' },
      h('h3', {}, 'Nouveau produit'),
      h('div', { class: 'form-grid' },
        h('label', {}, 'Nom', h('input', { name: 'name', required: true })),
        h('label', {}, 'Description', h('input', { name: 'description' }))),
      h('button', { type: 'submit' }, 'Créer'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(form);
      run(() => api('pm', 'POST', '/products', {
        name: data.get('name').trim(),
        description: data.get('description').trim(),
      }), 'Produit créé.');
    });
    nodes.push(form);
  }
  render(...nodes);
}

function profileForm(product) {
  const select = h('select', { name: 'scope' }, SCOPES.map((s) => h('option', { value: s, selected: s === 'TIER2' }, s)));
  const form = h('form', { class: 'card' },
    h('h3', {}, `Nouveau profil pour ${product.name}`),
    h('p', { class: 'empty' }, 'La création du profil provisionne le groupe correspondant dans l\'annuaire.'),
    h('div', { class: 'form-grid' },
      h('label', {}, 'Nom du groupe', h('input', { name: 'name', required: true })),
      h('label', {}, 'Description', h('input', { name: 'description' })),
      h('label', {}, 'Périmètre (niveau d\'administration)', select)),
    h('p', { class: 'empty' }, 'TIER0 : infrastructure d\'identité (annuaire, contrôleurs de domaine) ; TIER1 : serveurs et applications ; TIER2 : postes et utilisateurs standard.'),
    h('button', { type: 'submit' }, 'Créer le profil'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    run(() => api('pm', 'POST', `/products/${encodeURIComponent(product.name)}/profiles`, {
      name: data.get('name').trim(),
      description: data.get('description').trim(),
      scope: data.get('scope'),
    }), 'Profil créé, job de provisioning publié.');
  });
  main.append(form);
  form.scrollIntoView();
}

// --- Vue générique : comptes -----------------------------------------------------------------

/**
 * Comptes d'un service. `link` décrit la corrélation : champ du compte (`product` ou `identity`),
 * libellé et route de corrélation manuelle.
 */
function accountsView(config) {
  return async () => {
    const filters = accountsView.filters[config.service];
    const query = new URLSearchParams();
    if (filters.link) query.set(config.link.field, filters.link);
    if (filters.type) query.set('type', filters.type);
    if (filters.uncorrelated) query.set('uncorrelated', 'true');
    const [types, accounts] = await Promise.all([
      api(config.service, 'GET', '/account-types'),
      api(config.service, 'GET', `/accounts${query.size ? `?${query}` : ''}`),
    ]);

    const filterForm = h('form', { class: 'toolbar' },
      h('label', {}, config.link.label, h('input', { name: 'link', value: filters.link })),
      h('label', {}, 'Type', h('select', { name: 'type' },
        h('option', { value: '' }, 'Tous'),
        types.map((t) => h('option', { value: t.name, selected: t.name === filters.type }, t.name)))),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'uncorrelated', checked: filters.uncorrelated }), 'Non corrélés'),
      h('button', { type: 'submit', class: 'secondary' }, 'Filtrer'),
      canWrite() && h('button', {
        type: 'button',
        onclick: () => run(async () => {
          const result = await api(config.service, 'POST', '/accounts/correlate');
          show(`${result.correlated} compte(s) corrélé(s).`, 'ok');
        }),
      }, 'Rejouer la corrélation'));
    filterForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(filterForm);
      filters.link = data.get('link').trim();
      filters.type = data.get('type');
      filters.uncorrelated = data.get('uncorrelated') === 'on';
      currentView();
    });

    const typeByName = new Map(types.map((t) => [t.name, t]));
    const list = table(
      [
        { label: 'Compte', cell: (a) => a.identifier, mono: true },
        { label: 'Type', cell: (a) => a.type },
        {
          label: config.link.label,
          cell: (a) => (a[config.link.field] ? a[config.link.field] : h('span', { class: 'badge warn' }, 'non corrélé')),
        },
        { label: 'Origine', cell: (a) => h('span', { class: 'badge' }, a.source) },
        { label: 'Métadonnées', cell: (a) => JSON.stringify(a.metadata || {}), mono: true },
        {
          label: '',
          cell: (a) =>
            canWrite()
              ? h('div', { class: 'actions' },
                  h('button', { type: 'button', class: 'secondary', onclick: () => accountEditor(config, a, typeByName.get(a.type)) }, 'Modifier'),
                  h('button', {
                    type: 'button',
                    class: 'danger',
                    onclick: confirmThen(`Supprimer le compte ${a.identifier} ? Un job de déprovisioning sera publié.`, () =>
                      run(() => api(config.service, 'DELETE', `/accounts/${encodeURIComponent(a.identifier)}`), 'Compte supprimé.')),
                  }, 'Supprimer'))
              : '',
        },
      ],
      accounts,
      'Aucun compte.',
    );

    const nodes = [h('h2', {}, config.title), filterForm, list];
    if (canWrite()) nodes.push(accountCreator(config, types));
    render(...nodes);
  };
}
accountsView.filters = {
  pm: { link: '', type: '', uncorrelated: false },
  im: { link: '', type: '', uncorrelated: false },
};

function accountCreator(config, types) {
  const typeSelect = h('select', { name: 'type' },
    h('option', { value: '' }, 'Déduit de l\'identifiant'),
    types.map((t) => h('option', { value: t.name }, t.name)));
  const metadataHost = h('div');
  let metadata = metadataForm(null);
  typeSelect.addEventListener('change', () => {
    metadata = metadataForm(types.find((t) => t.name === typeSelect.value));
    metadataHost.replaceChildren(metadata.element);
  });
  const form = h('form', { class: 'card' },
    h('h3', {}, 'Nouveau compte'),
    h('div', { class: 'form-grid' },
      h('label', {}, config.service === 'im' ? 'Identifiant (généré si vide)' : 'Identifiant',
        h('input', { name: 'identifier', required: config.service !== 'im' })),
      h('label', {}, 'Type', typeSelect),
      h('label', {}, `${config.link.label} (optionnel)`, h('input', { name: 'link' }))),
    metadataHost,
    h('button', { type: 'submit' }, 'Créer le compte'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    run(async () => {
      const body = { metadata: metadata.read() };
      if (data.get('identifier').trim()) body.identifier = data.get('identifier').trim();
      if (data.get('type')) body.type = data.get('type');
      if (data.get('link').trim()) body[config.link.field] = data.get('link').trim();
      await api(config.service, 'POST', '/accounts', body);
    }, 'Compte créé, job de provisioning publié.');
  });
  return form;
}

function accountEditor(config, account, type) {
  const metadata = metadataForm(type, account.metadata || {});
  const linkInput = h('input', { name: 'link', value: account[config.link.field] || '' });
  const form = h('form', { class: 'card' },
    h('h3', {}, `Modifier ${account.identifier}`),
    h('div', { class: 'form-grid' }, h('label', {}, config.link.label, linkInput)),
    metadata.element,
    h('div', { class: 'actions' },
      h('button', { type: 'submit' }, 'Enregistrer'),
      h('button', { type: 'button', class: 'secondary', onclick: () => form.remove() }, 'Annuler')));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      const id = encodeURIComponent(account.identifier);
      await api(config.service, 'PUT', `/accounts/${id}/metadata`, metadata.read());
      const link = linkInput.value.trim();
      if (link && link !== account[config.link.field]) {
        await api(config.service, 'PUT', `/accounts/${id}/${config.link.field}`, { [config.link.field]: link });
      }
    }, 'Compte mis à jour.');
  });
  main.append(form);
  form.scrollIntoView();
}

const serviceAccounts = { service: 'pm', title: 'Comptes de service', link: { field: 'product', label: 'Produit' } };
const userAccounts = { service: 'im', title: 'Comptes utilisateurs', link: { field: 'identity', label: 'Identité (matricule)' } };

// --- Vue : identités -------------------------------------------------------------------------

async function identitiesView() {
  const identities = await api('im', 'GET', '/identities');
  const nodes = [
    h('h2', {}, 'Identités'),
    table(
      [
        { label: 'Matricule', cell: (i) => i.employeeId, mono: true },
        { label: 'Prénom', cell: (i) => i.firstName || '' },
        { label: 'Nom', cell: (i) => i.lastName || '' },
        { label: 'E-mail', cell: (i) => i.email || '' },
        {
          label: '',
          cell: (i) =>
            h('div', { class: 'actions' },
              h('button', { type: 'button', class: 'secondary', onclick: () => identityAccounts(i) }, 'Comptes'),
              h('button', { type: 'button', class: 'secondary', onclick: () => identityContracts(i) }, 'Contrats'),
              canWrite() && h('button', {
                type: 'button',
                class: 'danger',
                onclick: confirmThen(`Supprimer l'identité ${i.employeeId} ? Ses comptes deviendront non corrélés.`, () =>
                  run(() => api('im', 'DELETE', `/identities/${encodeURIComponent(i.employeeId)}`), 'Identité supprimée.')),
              }, 'Supprimer')),
        },
      ],
      identities,
      'Aucune identité.',
    ),
  ];
  if (canWrite()) {
    const form = h('form', { class: 'card' },
      h('h3', {}, 'Nouvelle identité'),
      h('div', { class: 'form-grid' },
        h('label', {}, 'Prénom', h('input', { name: 'firstName' })),
        h('label', {}, 'Nom', h('input', { name: 'lastName' })),
        h('label', {}, 'E-mail', h('input', { name: 'email', type: 'email' }))),
      h('p', { class: 'empty' }, 'Le matricule est généré à la création.'),
      h('button', { type: 'submit' }, 'Créer'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(form);
      run(async () => {
        const created = await api('im', 'POST', '/identities', {
          firstName: data.get('firstName').trim(),
          lastName: data.get('lastName').trim(),
          email: data.get('email').trim(),
        });
        show(`Identité créée : matricule ${created.employeeId}.`, 'ok');
      });
    });
    nodes.push(form);
  }
  render(...nodes);
}

async function identityAccounts(identity) {
  clearMessage();
  try {
    const accounts = await api('im', 'GET', `/identities/${encodeURIComponent(identity.employeeId)}/accounts`);
    const panel = h('div', { class: 'card' },
      h('h3', {}, `Comptes de ${identity.employeeId}`),
      table(
        [
          { label: 'Compte', cell: (a) => a.identifier, mono: true },
          { label: 'Type', cell: (a) => a.type },
          { label: 'Origine', cell: (a) => a.source },
        ],
        accounts,
        'Aucun compte corrélé à cette identité.',
      ));
    main.append(panel);
    panel.scrollIntoView();
  } catch (error) {
    if (session) show(error.message);
  }
}

/** Contrats d'une identité : liste, création et suppression ; les métadonnées dépendent du type de contrat. */
async function identityContracts(identity) {
  clearMessage();
  try {
    const id = encodeURIComponent(identity.employeeId);
    const [types, contracts] = await Promise.all([
      api('im', 'GET', '/contract-types'),
      api('im', 'GET', `/identities/${id}/contracts`),
    ]);
    const panel = h('div', { class: 'card' },
      h('h3', {}, `Contrats de ${identity.employeeId}`),
      table(
        [
          { label: 'Type', cell: (c) => c.type },
          { label: 'Début', cell: (c) => c.startDate || '' },
          { label: 'Fin', cell: (c) => c.endDate || '' },
          { label: 'Métadonnées', cell: (c) => JSON.stringify(c.metadata || {}), mono: true },
          {
            label: '',
            cell: (c) =>
              canWrite()
                ? h('button', {
                    type: 'button',
                    class: 'danger',
                    onclick: confirmThen(`Supprimer ce contrat ${c.type} ?`, () =>
                      run(() => api('im', 'DELETE', `/identities/${id}/contracts/${c.id}`), 'Contrat supprimé.')),
                  }, 'Supprimer')
                : '',
          },
        ],
        contracts,
        'Aucun contrat pour cette identité.',
      ));
    if (canWrite() && types.length > 0) panel.append(contractCreator(identity, types));
    main.append(panel);
    panel.scrollIntoView();
  } catch (error) {
    if (session) show(error.message);
  }
}

function contractCreator(identity, types) {
  const typeSelect = h('select', { name: 'type', required: true }, types.map((t) => h('option', { value: t.name }, t.name)));
  const metadataHost = h('div');
  let metadata = metadataForm(types[0]);
  metadataHost.replaceChildren(metadata.element);
  typeSelect.addEventListener('change', () => {
    metadata = metadataForm(types.find((t) => t.name === typeSelect.value));
    metadataHost.replaceChildren(metadata.element);
  });
  const form = h('form', {},
    h('h4', {}, 'Nouveau contrat'),
    h('div', { class: 'form-grid' },
      h('label', {}, 'Type', typeSelect),
      h('label', {}, 'Début', h('input', { name: 'startDate', type: 'date' })),
      h('label', {}, 'Fin', h('input', { name: 'endDate', type: 'date' }))),
    metadataHost,
    h('button', { type: 'submit' }, 'Ajouter le contrat'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    run(() => api('im', 'POST', `/identities/${encodeURIComponent(identity.employeeId)}/contracts`, {
      type: data.get('type'),
      startDate: data.get('startDate') || null,
      endDate: data.get('endDate') || null,
      metadata: metadata.read(),
    }), 'Contrat ajouté.');
  });
  return form;
}

// --- Vue : types de compte -------------------------------------------------------------------

async function typesView() {
  const [pm, im, contractTypes] = await Promise.all([
    api('pm', 'GET', '/account-types'),
    api('im', 'GET', '/account-types'),
    api('im', 'GET', '/contract-types'),
  ]);
  const fields = (t) => (t.metadata || []).map((m) => `${m.name}:${m.type}${m.required ? '*' : ''}`).join(', ') || '—';
  const columns = [
    { label: 'Nom', cell: (t) => t.name },
    { label: 'Nature', cell: (t) => h('span', { class: `badge ${String(t.kind).toLowerCase()}` }, t.kind) },
    { label: 'Expression régulière', cell: (t) => t.pattern, mono: true },
    { label: 'Métadonnées', cell: fields },
  ];
  const userColumns = [
    ...columns,
    { label: 'Matricule déduit', cell: (t) => t.identityTemplate || '—', mono: true },
    { label: 'Identifiant généré', cell: (t) => t.identifierTemplate || '—', mono: true },
  ];
  render(
    h('h2', {}, 'Types'),
    h('p', { class: 'empty' }, 'Définis par la configuration du déploiement ; l\'expression régulière relie un compte à son produit ou à son identité.'),
    h('h3', {}, 'Comptes de service (product-manager)'),
    table(columns, pm, 'Aucun type configuré.'),
    h('h3', {}, 'Comptes utilisateurs (identity-manager)'),
    table(userColumns, im, 'Aucun type configuré.'),
    h('h3', {}, 'Contrats (identity-manager)'),
    table([{ label: 'Nom', cell: (t) => t.name }, { label: 'Métadonnées', cell: fields }], contractTypes, 'Aucun type de contrat configuré.'),
  );
}

// --- Navigation ------------------------------------------------------------------------------

const VIEWS = [
  { id: 'products', label: 'Produits', render: productsView },
  { id: 'service-accounts', label: 'Comptes de service', render: accountsView(serviceAccounts) },
  { id: 'identities', label: 'Identités', render: identitiesView },
  { id: 'user-accounts', label: 'Comptes utilisateurs', render: accountsView(userAccounts) },
  { id: 'types', label: 'Types', render: typesView },
];

async function navigate(id) {
  const view = VIEWS.find((v) => v.id === id) || VIEWS[0];
  currentView = async () => {
    try {
      await view.render();
    } catch (error) {
      if (session) {
        render();
        show(error.message);
      }
    }
  };
  for (const button of nav.children) {
    if (button.dataset.view === view.id) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (window.location.hash !== `#${view.id}`) history.replaceState(null, '', `#${view.id}`);
  clearMessage();
  await currentView();
}

function showApp() {
  topbar.hidden = false;
  document.getElementById('whoami').textContent = session.user;
  document.getElementById('roles').textContent = session.roles.join(', ') || 'aucun rôle';
  document.getElementById('avatar').textContent = String(session.user).charAt(0);
  nav.replaceChildren(...VIEWS.map((v) => h('button', { type: 'button', 'data-view': v.id, onclick: () => navigate(v.id) }, v.label)));
  navigate(window.location.hash.slice(1));
}

function showLogin() {
  topbar.hidden = true;
  const form = h('form', { id: 'login', class: 'card', autocomplete: 'on' },
    h('div', { class: 'login-brand' },
      h('span', { class: 'logo', 'aria-hidden': 'true' }, 'A'),
      h('div', {}, h('h2', {}, 'ARC Console'), h('p', {}, 'Connectez-vous pour continuer'))),
    h('label', {}, 'Identifiant', h('input', { name: 'username', type: 'text', autocomplete: 'username', required: true })),
    h('label', {}, 'Mot de passe', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
    h('button', { type: 'submit' }, 'Se connecter'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMessage();
    const data = new FormData(form);
    try {
      await login(data.get('username').trim(), data.get('password'));
      showApp();
    } catch (error) {
      show(error.message);
    }
  });
  render(form);
}

document.getElementById('logout').addEventListener('click', () => logout());

session = loadSession();
if (session) showApp();
else showLogin();
