const firebaseConfig = {
  apiKey: 'AIzaSyBJamDNDq4RCJP9BCK8nQ1qOWyGXfZec08',
  authDomain: 'pulsespark-prototype.firebaseapp.com',
  projectId: 'pulsespark-prototype',
  storageBucket: 'pulsespark-prototype.appspot.com',
  messagingSenderId: '694965858371',
  appId: '1:694965858371:web:30137be4a2dbc27c29e4f6',
  measurementId: 'G-VXNQ68DE3J'
};

const ADMIN_API_BASE = (() => {
  const override = (localStorage.getItem('ping_admin_api_base') || '').trim();
  return (override || 'http://localhost:4180').replace(/\/$/, '');
})();
const APP_ENTITLEMENT_OPTIONS = [
  { value: 'monthly_signal_access', label: 'Monthly signal readout' },
  { value: 'beta_features', label: 'Beta features' },
  { value: 'shared_history_plus', label: 'Expanded shared history' }
];
const ADMIN_ROLE_OPTIONS = [
  { value: 'member', label: 'Member' },
  { value: 'org_admin', label: 'Org admin' },
  { value: 'org_support', label: 'Org support' }
];

const fallbackAppInfo = {
  name: 'Ping Admin',
  environment: 'Local prototype',
  signedInAs: 'Allie Heiniger',
  updatedAt: 'July 14, 2026 at 4:30 PM ET'
};

const pageMeta = {
  dashboard: {
    title: 'Overview',
    subtitle: 'See what is happening across Ping right now, then scope into a single organization when you need detail.'
  },
  organizations: {
    title: 'Organizations',
    subtitle: 'Set up orgs, keep names clean, and understand which groups are active versus half-formed.'
  },
  people: {
    title: 'People, Invites & Access',
    subtitle: 'Invite verified members into an org, assign roles, and set optional in-app entitlements without changing the current desktop beta flow yet.'
  },
  activity: {
    title: 'Activity',
    subtitle: 'Start with summary counts, then drill into detailed logs by organization and event type.'
  },
  health: {
    title: 'Health & Support',
    subtitle: 'Watch backend confidence, version reporting readiness, and the places where data still needs to be added.'
  }
};

const eventTypeLabels = {
  response_answered: 'Answered question',
  ping_sent: 'Sent ping',
  team_analysis_generated: 'Team analysis generated',
  profile_synced: 'Profile synced',
  invite_created: 'Invite created'
};

const state = {
  page: document.body.dataset.page || 'dashboard',
  orgFilter: 'all',
  eventFilter: 'all',
  showDetailedActivity: false,
  db: null,
  liveData: {
    organizations: [],
    profiles: [],
    responses: [],
    pings: [],
    dashboards: []
  },
  adminApi: {
    ready: false,
    organizations: [],
    invites: [],
    memberships: [],
    lastCreatedInvite: null,
    error: null
  },
  loadErrors: [],
  uiMessage: null
};

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeIdentity(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function titleCase(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatRelativeDateLabel(date) {
  if (!date) return 'No recent activity';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  const diffHours = Math.round(diffMs / 3600000);
  if (diffHours < 24) return `${diffHours} hr ago`;
  const diffDays = Math.round(diffMs / 86400000);
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTimestamp(date) {
  if (!date) return '—';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function getQueryParams() {
  return new URLSearchParams(window.location.search);
}

function applyQueryState() {
  const params = getQueryParams();
  state.orgFilter = params.get('org') || 'all';
  state.eventFilter = params.get('event') || 'all';
  state.showDetailedActivity = params.get('detail') === '1';
}

function updateQueryState(next = {}) {
  const params = getQueryParams();
  const merged = {
    org: state.orgFilter,
    event: state.eventFilter,
    detail: state.showDetailedActivity ? '1' : '0',
    ...next
  };

  Object.entries(merged).forEach(([key, value]) => {
    if (!value || value === 'all' || value === '0') params.delete(key);
    else params.set(key, value);
  });

  const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
  window.history.replaceState({}, '', nextUrl);
}

function createPlaceholderBadge(label = 'Data coming') {
  return `<span class="placeholder-badge">${escapeHtml(label)}</span>`;
}

function metricCard(label, value, note, extraClass = '') {
  return `
    <article class="metric-card card ${extraClass}">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)}</div>
      <div class="metric-note">${escapeHtml(note)}</div>
    </article>
  `;
}

function parsePossibleDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') {
    try {
      return value.toDate();
    } catch {
      return null;
    }
  }
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function deriveDateFromResponse(response) {
  return parsePossibleDate(response.timestamp)
    || parsePossibleDate(response.createdAt)
    || parsePossibleDate(response.generatedAt)
    || (response.date ? new Date(`${response.date}T12:00:00`) : null);
}

function buildFirebase() {
  if (!window.firebase) {
    state.loadErrors.push('Firebase web SDK did not load.');
    return null;
  }

  try {
    const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(firebaseConfig);
    return firebase.firestore(app);
  } catch (error) {
    state.loadErrors.push(`Firebase init failed: ${error.message}`);
    return null;
  }
}

async function loadLiveData() {
  state.db = buildFirebase();
  if (!state.db) return;

  const loaders = [
    { key: 'organizations', run: () => state.db.collection('organizations').get() },
    { key: 'profiles', run: () => state.db.collection('user_profiles').get() },
    { key: 'responses', run: () => state.db.collection('responses').get() },
    { key: 'pings', run: () => state.db.collection('pings').get() },
    { key: 'dashboards', run: () => state.db.collection('ai_dashboards').get() }
  ];

  const results = await Promise.allSettled(loaders.map((loader) => loader.run()));
  results.forEach((result, index) => {
    const key = loaders[index].key;
    if (result.status === 'fulfilled') {
      state.liveData[key] = result.value.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    } else {
      state.loadErrors.push(`Could not load ${key}: ${result.reason?.message || result.reason}`);
      state.liveData[key] = [];
    }
  });
}

async function loadAdminApiData() {
  try {
    const response = await fetch(`${ADMIN_API_BASE}/api/bootstrap`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.adminApi.ready = true;
    state.adminApi.organizations = payload.organizations || [];
    state.adminApi.invites = payload.invites || [];
    state.adminApi.memberships = payload.memberships || [];
    state.adminApi.error = null;
  } catch (error) {
    state.adminApi.ready = false;
    state.adminApi.error = error.message || String(error);
  }
}

function allOrganizations() {
  const orgMap = new Map();

  state.liveData.organizations.forEach((orgDoc) => {
    const normalized = normalizeIdentity(orgDoc.name || orgDoc.organization || orgDoc.displayName || orgDoc.id);
    if (!normalized) return;
    orgMap.set(normalized, {
      normalized,
      id: orgDoc.id,
      label: orgDoc.name || orgDoc.displayName || titleCase(orgDoc.id),
      raw: orgDoc
    });
  });

  state.adminApi.organizations.forEach((orgDoc) => {
    const normalized = normalizeIdentity(orgDoc.name || orgDoc.id);
    if (!normalized) return;
    const existing = orgMap.get(normalized);
    orgMap.set(normalized, {
      normalized,
      id: orgDoc.id,
      label: orgDoc.name || titleCase(orgDoc.id),
      raw: existing?.raw || orgDoc
    });
  });

  state.liveData.profiles.forEach((profile) => {
    const normalized = normalizeIdentity(profile.organization || profile.normalizedOrganization);
    if (!normalized || orgMap.has(normalized)) return;
    orgMap.set(normalized, {
      normalized,
      id: normalized,
      label: profile.organization || titleCase(profile.normalizedOrganization),
      raw: null
    });
  });

  state.liveData.responses.forEach((response) => {
    const normalized = normalizeIdentity(response.organization);
    if (!normalized || orgMap.has(normalized)) return;
    orgMap.set(normalized, {
      normalized,
      id: normalized,
      label: response.organization || titleCase(normalized),
      raw: null
    });
  });

  return [...orgMap.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function selectedOrg() {
  return allOrganizations().find((org) => org.normalized === state.orgFilter) || null;
}

function selectedOrgLabel() {
  return selectedOrg()?.label || 'All organizations';
}

function orgMatches(value) {
  if (state.orgFilter === 'all') return true;
  return normalizeIdentity(value) === state.orgFilter;
}

function uniqueBy(values) {
  return [...new Set(values.filter(Boolean))];
}

function getProfilesForOrg(orgNormalized) {
  return state.liveData.profiles.filter((profile) => normalizeIdentity(profile.organization || profile.normalizedOrganization) === orgNormalized);
}

function getResponsesForOrg(orgNormalized) {
  return state.liveData.responses.filter((response) => normalizeIdentity(response.organization) === orgNormalized);
}

function getPingsForOrg(orgNormalized) {
  return state.liveData.pings.filter((ping) => normalizeIdentity(ping.organization) === orgNormalized);
}

function getDashboardsForOrg(orgNormalized) {
  return state.liveData.dashboards.filter((dashboard) => normalizeIdentity(dashboard.organization || dashboard.orgName || '') === orgNormalized);
}

function getInvitesForOrg(org) {
  if (state.orgFilter === 'all') return state.adminApi.invites;
  const orgId = selectedOrg()?.id;
  return state.adminApi.invites.filter((invite) => invite.organizationId === orgId || normalizeIdentity(invite.organizationName) === org);
}

function getMembershipsForOrg(org) {
  if (state.orgFilter === 'all') return state.adminApi.memberships;
  const orgId = selectedOrg()?.id;
  return state.adminApi.memberships.filter((membership) => membership.organizationId === orgId || normalizeIdentity(membership.organizationName) === org);
}

function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getStartOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function getSevenDaysAgo() {
  const today = getStartOfToday();
  const seven = new Date(today);
  seven.setDate(today.getDate() - 6);
  return seven;
}

function getThisWeekStart() {
  const today = getStartOfToday();
  const result = new Date(today);
  result.setDate(today.getDate() - today.getDay());
  return result;
}

function buildOrgSummaries() {
  const todayKey = getTodayKey();
  const sevenDaysAgo = getSevenDaysAgo();

  return allOrganizations().map((org) => {
    const profiles = getProfilesForOrg(org.normalized);
    const responses = getResponsesForOrg(org.normalized);
    const pings = getPingsForOrg(org.normalized);
    const invites = getInvitesForOrg(org.normalized);
    const observedPeople = uniqueBy([
      ...profiles.map((profile) => profile.displayName || profile.username),
      ...responses.map((response) => response.username),
      ...invites.map((invite) => invite.email)
    ]);

    const responsesToday = responses.filter((response) => (response.date || '') === todayKey || deriveDateFromResponse(response)?.toDateString() === getStartOfToday().toDateString());
    const activeInSevenDays = uniqueBy(
      responses
        .filter((response) => {
          const date = deriveDateFromResponse(response);
          return date && date >= sevenDaysAgo;
        })
        .map((response) => response.username)
    );

    const lastActivity = [
      ...responses.map(deriveDateFromResponse),
      ...profiles.map((profile) => parsePossibleDate(profile.updatedAt)),
      ...pings.map((ping) => parsePossibleDate(ping.timestamp)),
      ...invites.map((invite) => parsePossibleDate(invite.createdAt))
    ].filter(Boolean).sort((a, b) => b - a)[0] || null;

    return {
      normalized: org.normalized,
      id: org.id,
      label: org.label,
      observedPeople: observedPeople.length,
      invitedPeople: invites.length,
      responsesToday: responsesToday.length,
      activeInSevenDays: activeInSevenDays.length,
      todayResponseRate: observedPeople.length ? Math.round((responsesToday.length / observedPeople.length) * 100) : 0,
      lastActivity,
      pendingInvites: invites.filter((invite) => invite.status === 'pending').length
    };
  });
}

function buildPeople() {
  const responseByPerson = new Map();
  const pingByPerson = new Map();
  const membershipByEmail = new Map();

  state.adminApi.memberships.forEach((membership) => {
    const key = `${membership.organizationId || normalizeIdentity(membership.organizationName)}__${normalizeIdentity(membership.email)}`;
    membershipByEmail.set(key, membership);
  });

  state.liveData.responses.forEach((response) => {
    const key = `${normalizeIdentity(response.organization)}__${normalizeIdentity(response.username)}`;
    const date = deriveDateFromResponse(response);
    const existing = responseByPerson.get(key) || { count: 0, lastSeen: null, answeredToday: 0 };
    existing.count += 1;
    if (response.date === getTodayKey()) existing.answeredToday += 1;
    if (date && (!existing.lastSeen || date > existing.lastSeen)) existing.lastSeen = date;
    responseByPerson.set(key, existing);
  });

  state.liveData.pings.forEach((ping) => {
    const date = parsePossibleDate(ping.timestamp);
    [ping.fromUser, ping.toUser].forEach((name) => {
      const key = `${normalizeIdentity(ping.organization)}__${normalizeIdentity(name)}`;
      const existing = pingByPerson.get(key) || { count: 0, lastSeen: null };
      existing.count += 1;
      if (date && (!existing.lastSeen || date > existing.lastSeen)) existing.lastSeen = date;
      pingByPerson.set(key, existing);
    });
  });

  const profilePeople = state.liveData.profiles
    .filter((profile) => orgMatches(profile.organization || profile.normalizedOrganization))
    .map((profile) => {
      const org = profile.organization || titleCase(profile.normalizedOrganization);
      const orgNorm = normalizeIdentity(org);
      const key = `${orgNorm}__${normalizeIdentity(profile.displayName || profile.username)}`;
      const responseStats = responseByPerson.get(key) || { count: 0, lastSeen: null, answeredToday: 0 };
      const pingStats = pingByPerson.get(key) || { count: 0, lastSeen: null };
      const membership = state.adminApi.memberships.find((item) => normalizeIdentity(item.organizationName) === orgNorm && normalizeIdentity(item.displayName || item.email) === normalizeIdentity(profile.displayName || profile.username));
      const lastSeen = [responseStats.lastSeen, pingStats.lastSeen, parsePossibleDate(profile.updatedAt)].filter(Boolean).sort((a, b) => b - a)[0] || null;

      return {
        source: 'profile',
        name: profile.displayName || profile.username || 'Unknown user',
        organization: org,
        organizationNormalized: orgNorm,
        email: membership?.email || null,
        answeredCount: responseStats.count,
        answeredToday: responseStats.answeredToday,
        pingTouches: pingStats.count,
        lastSeen,
        adminRole: membership?.adminRole || null,
        appEntitlements: membership?.appEntitlements || [],
        onboardingStatus: typeof profile.onboardingComplete === 'boolean' ? (profile.onboardingComplete ? 'Complete' : 'In progress') : 'Observed in profile data',
        membershipStatus: membership?.status || null
      };
    });

  const inviteOnlyPeople = state.adminApi.invites
    .filter((invite) => orgMatches(invite.organizationName))
    .filter((invite) => !profilePeople.some((person) => normalizeIdentity(person.email || person.name) === normalizeIdentity(invite.email) && normalizeIdentity(person.organization) === normalizeIdentity(invite.organizationName)))
    .map((invite) => ({
      source: 'invite',
      name: invite.email,
      organization: invite.organizationName,
      organizationNormalized: normalizeIdentity(invite.organizationName),
      email: invite.email,
      answeredCount: 0,
      answeredToday: 0,
      pingTouches: 0,
      lastSeen: parsePossibleDate(invite.createdAt),
      adminRole: invite.adminRole || null,
      appEntitlements: invite.appEntitlements || [],
      onboardingStatus: 'Not started',
      membershipStatus: invite.status || 'pending'
    }));

  return [...profilePeople, ...inviteOnlyPeople].sort((a, b) => a.organization.localeCompare(b.organization) || a.name.localeCompare(b.name));
}

function buildActivityEvents() {
  const events = [];

  state.liveData.responses.forEach((response) => {
    if (!orgMatches(response.organization)) return;
    events.push({
      type: 'response_answered',
      org: response.organization,
      actor: response.username,
      occurredAt: deriveDateFromResponse(response),
      title: `${response.username || 'Someone'} answered a question`,
      detail: response.isOnboarding ? 'Onboarding response' : `Question ${response.questionId || 'daily prompt'}`
    });
  });

  state.liveData.pings.forEach((ping) => {
    if (!orgMatches(ping.organization)) return;
    events.push({
      type: 'ping_sent',
      org: ping.organization,
      actor: ping.fromUser,
      occurredAt: parsePossibleDate(ping.timestamp),
      title: `${ping.fromUser || 'Someone'} pinged ${ping.toUser || 'someone'}`,
      detail: 'Match activity signal'
    });
  });

  state.liveData.dashboards.forEach((dashboard) => {
    const org = dashboard.organization || dashboard.orgName || '';
    if (!orgMatches(org)) return;
    events.push({
      type: 'team_analysis_generated',
      org,
      actor: 'Ping AI',
      occurredAt: parsePossibleDate(dashboard.generatedAt),
      title: 'Team analysis generated',
      detail: dashboard.weekId ? `Week ${dashboard.weekId}` : 'Cached team reflection'
    });
  });

  state.liveData.profiles.forEach((profile) => {
    const org = profile.organization || profile.normalizedOrganization;
    if (!orgMatches(org)) return;
    events.push({
      type: 'profile_synced',
      org,
      actor: profile.displayName || profile.username,
      occurredAt: parsePossibleDate(profile.updatedAt),
      title: `${profile.displayName || profile.username || 'A user'} synced profile data`,
      detail: profile.avatarType === 'photo' ? 'Uploaded photo avatar' : 'Avatar/profile sync'
    });
  });

  state.adminApi.invites.forEach((invite) => {
    if (!orgMatches(invite.organizationName)) return;
    events.push({
      type: 'invite_created',
      org: invite.organizationName,
      actor: invite.createdBy || 'Ping admin',
      occurredAt: parsePossibleDate(invite.createdAt),
      title: `Invite created for ${invite.email}`,
      detail: `${invite.adminRole || 'member'} · ${invite.authMethod || 'magic_link'}`
    });
  });

  return events.filter((event) => event.occurredAt).sort((a, b) => b.occurredAt - a.occurredAt);
}

function getFilteredEvents() {
  return buildActivityEvents().filter((event) => state.eventFilter === 'all' || event.type === state.eventFilter);
}

function buildOverviewMetrics() {
  const orgSummaries = buildOrgSummaries();
  const people = buildPeople();
  const events = buildActivityEvents();
  const today = getStartOfToday();
  const weekStart = getThisWeekStart();

  return {
    orgSummaries,
    people,
    events,
    answeredToday: events.filter((event) => event.type === 'response_answered' && event.occurredAt >= today).length,
    activeTodayPeople: uniqueBy(events.filter((event) => event.occurredAt >= today).map((event) => `${normalizeIdentity(event.org)}__${normalizeIdentity(event.actor)}`)).length,
    pingsThisWeek: events.filter((event) => event.type === 'ping_sent' && event.occurredAt >= weekStart).length,
    analysesThisWeek: events.filter((event) => event.type === 'team_analysis_generated' && event.occurredAt >= weekStart).length,
    pendingInvites: state.adminApi.invites.filter((invite) => invite.status === 'pending' && (state.orgFilter === 'all' || orgMatches(invite.organizationName))).length
  };
}

function renderTopShell() {
  const meta = pageMeta[state.page];
  byId('page-title').textContent = meta.title;
  byId('page-subtitle').textContent = meta.subtitle;
  byId('signed-in-as').textContent = fallbackAppInfo.signedInAs;
  byId('environment-name').textContent = state.adminApi.ready ? 'Local admin API connected' : fallbackAppInfo.environment;
  byId('last-updated').textContent = `Updated ${fallbackAppInfo.updatedAt}`;
  byId('org-breadcrumb').textContent = state.orgFilter === 'all' ? 'All organizations' : `All organizations / ${selectedOrgLabel()}`;

  document.querySelectorAll('[data-nav]').forEach((link) => {
    const isActive = link.dataset.nav === state.page;
    link.classList.toggle('is-active', isActive);
    if (isActive) link.setAttribute('aria-current', 'page');
    const href = new URL(link.getAttribute('href'), window.location.href);
    if (state.orgFilter !== 'all') href.searchParams.set('org', state.orgFilter);
    else href.searchParams.delete('org');
    link.setAttribute('href', `${href.pathname.split('/').pop()}${href.search}`);
  });

  const orgSwitcher = byId('org-switcher');
  const orgs = allOrganizations();
  orgSwitcher.innerHTML = [`<option value="all">All organizations</option>`]
    .concat(orgs.map((org) => `<option value="${escapeHtml(org.normalized)}">${escapeHtml(org.label)}</option>`))
    .join('');
  orgSwitcher.value = orgs.some((org) => org.normalized === state.orgFilter) ? state.orgFilter : 'all';
}

function renderOverview() {
  const { orgSummaries, answeredToday, activeTodayPeople, pingsThisWeek, analysesThisWeek, pendingInvites } = buildOverviewMetrics();
  const inScope = orgSummaries.filter((org) => state.orgFilter === 'all' || org.normalized === state.orgFilter);

  byId('page-content').innerHTML = `
    <section class="metric-grid metric-grid--five">
      ${metricCard('Organizations in scope', inScope.length, state.orgFilter === 'all' ? 'Live org docs and observed activity combined' : `Scoped to ${selectedOrgLabel()}`)}
      ${metricCard('Answered questions today', answeredToday, 'Derived live from responses')}
      ${metricCard('People active today', activeTodayPeople, 'Any response, ping, or visible profile activity')}
      ${metricCard('Pending invites', pendingInvites, state.adminApi.ready ? 'Live from admin invite records' : 'Start local admin API to create invites')}
      ${metricCard('Version reporting', 'Data coming', 'We should add app version capture to membership/profile activity.', 'metric-card--placeholder')}
    </section>

    <section class="panel-grid panel-grid--two">
      <article class="panel card">
        <div class="panel-head">
          <h2>Customer-ready auth path</h2>
          <span class="tag">Chosen direction</span>
        </div>
        <ul class="plain-list">
          <li>Web-hosted admin invite system</li>
          <li>Magic-link sign-in for the desktop app</li>
          <li>Org-bound membership records in Firestore</li>
          <li>Role and entitlement fields from day one</li>
        </ul>
        <div class="callout top-gap">This admin prototype now covers the first part of that plan: creating invite records and pending memberships before we swap the desktop app over.</div>
      </article>

      <article class="panel card">
        <div class="panel-head">
          <h2>What is live already</h2>
          <span class="tag tag--teal">Connected now</span>
        </div>
        <div class="availability-grid">
          <div class="availability-row"><span>Organizations</span><strong>Live data</strong></div>
          <div class="availability-row"><span>User profiles</span><strong>Live data</strong></div>
          <div class="availability-row"><span>Responses</span><strong>Live data</strong></div>
          <div class="availability-row"><span>Pings</span><strong>Live data</strong></div>
          <div class="availability-row"><span>Team dashboards</span><strong>Live data</strong></div>
          <div class="availability-row"><span>Invites / memberships</span><strong>${state.adminApi.ready ? 'Live through admin API' : 'Admin API not connected yet'}</strong></div>
        </div>
      </article>
    </section>

    <section class="panel card">
      <div class="panel-head">
        <h2>Organization snapshot</h2>
        <span class="tag tag--navy">Live beta data</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Organization</th>
              <th>Observed people</th>
              <th>Invited</th>
              <th>Answered today</th>
              <th>Pending invites</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            ${inScope.map((org) => `
              <tr>
                <td><div class="cell-title">${escapeHtml(org.label)}</div></td>
                <td>${org.observedPeople}</td>
                <td>${org.invitedPeople}</td>
                <td>${org.responsesToday}</td>
                <td>${org.pendingInvites}</td>
                <td>${escapeHtml(formatRelativeDateLabel(org.lastActivity))}</td>
              </tr>
            `).join('') || `<tr><td colspan="6" class="empty-row">No organizations matched this filter.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderOrganizations() {
  const orgSummaries = buildOrgSummaries().filter((org) => state.orgFilter === 'all' || org.normalized === state.orgFilter);

  byId('page-content').innerHTML = `
    <section class="panel-grid panel-grid--sidebar">
      <article class="panel card">
        <div class="panel-head">
          <h2>How org scoping should work</h2>
          <span class="tag">Super-admin friendly</span>
        </div>
        <ul class="plain-list">
          <li>Ping admins stay logged in once and switch between orgs from the top bar.</li>
          <li>Future org admins would land already scoped to just their organization.</li>
          <li>Invite and membership management should respect this same scope automatically.</li>
        </ul>
      </article>

      <article class="panel card">
        <div class="panel-head">
          <h2>Organizations</h2>
          <button class="button-small">New organization</button>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Org</th>
                <th>Observed people</th>
                <th>Invited</th>
                <th>Pending invites</th>
                <th>Active in 7 days</th>
              </tr>
            </thead>
            <tbody>
              ${orgSummaries.map((org) => `
                <tr>
                  <td><div class="cell-title">${escapeHtml(org.label)}</div></td>
                  <td>${org.observedPeople}</td>
                  <td>${org.invitedPeople}</td>
                  <td>${org.pendingInvites}</td>
                  <td>${org.activeInSevenDays}</td>
                </tr>
              `).join('') || `<tr><td colspan="5" class="empty-row">No organizations matched this filter.</td></tr>`}
            </tbody>
          </table>
        </div>
      </article>
    </section>

    <section class="panel-grid panel-grid--two">
      ${orgSummaries.map((org) => `
        <article class="panel card">
          <div class="panel-head">
            <h2>${escapeHtml(org.label)}</h2>
            <span class="tag tag--teal">${org.pendingInvites} pending invites</span>
          </div>
          <div class="detail-grid detail-grid--three">
            <div><span class="detail-label">Observed people</span><strong>${org.observedPeople}</strong></div>
            <div><span class="detail-label">Invited</span><strong>${org.invitedPeople}</strong></div>
            <div><span class="detail-label">Answered today</span><strong>${org.responsesToday}</strong></div>
          </div>
          <div class="callout subtle-callout top-gap">
            <strong>Alias cleanup:</strong> ${createPlaceholderBadge()}<br />
            <strong>Version reporting:</strong> ${createPlaceholderBadge()}
          </div>
        </article>
      `).join('') || `<article class="panel card"><p class="panel-copy">No organization data matched the current scope.</p></article>`}
    </section>
  `;
}

function entitlementCheckboxes(selected = []) {
  return APP_ENTITLEMENT_OPTIONS.map((option) => `
    <label class="checkbox-pill">
      <input type="checkbox" name="appEntitlements" value="${escapeHtml(option.value)}" ${selected.includes(option.value) ? 'checked' : ''} />
      <span>${escapeHtml(option.label)}</span>
    </label>
  `).join('');
}

function renderPeople() {
  const people = buildPeople();
  const invites = state.adminApi.invites.filter((invite) => state.orgFilter === 'all' || orgMatches(invite.organizationName));
  const orgs = allOrganizations();

  byId('page-content').innerHTML = `
    <section class="panel-grid panel-grid--sidebar">
      <article class="panel card">
        <div class="panel-head">
          <h2>Create invites</h2>
          <span class="tag tag--gold">Magic-link foundation</span>
        </div>
        <p class="panel-copy">This creates two records: an invite plus a pending org membership. That gives us a clean bridge into the future desktop magic-link flow.</p>
        ${state.adminApi.ready ? `
          <form id="invite-form" class="invite-form top-gap">
            <label>
              <span>Email</span>
              <input type="email" name="email" placeholder="jane@customer.com" required />
            </label>
            <label>
              <span>Organization</span>
              <select name="organizationId" required>
                ${orgs.map((org) => `<option value="${escapeHtml(org.id)}" ${state.orgFilter !== 'all' && org.normalized === state.orgFilter ? 'selected' : ''}>${escapeHtml(org.label)}</option>`).join('')}
              </select>
            </label>
            <label>
              <span>Admin tools role</span>
              <select name="adminRole">
                ${ADMIN_ROLE_OPTIONS.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('')}
              </select>
            </label>
            <fieldset>
              <legend>In-app extras</legend>
              <div class="checkbox-pill-grid">
                ${entitlementCheckboxes()}
              </div>
            </fieldset>
            <button class="button-small" type="submit">Create invite</button>
          </form>
        ` : `
          <div class="callout top-gap">Local admin API is not running yet, so invite creation is offline. Start the local invite server to turn this on.</div>
        `}
      </article>

      <article class="panel card">
        <div class="panel-head">
          <h2>Access model</h2>
          <span class="tag">Separate concerns</span>
        </div>
        <ul class="plain-list">
          <li><strong>Admin tools role</strong> controls the web console.</li>
          <li><strong>In-app extras</strong> controls optional pages like monthly signal.</li>
          <li>Those are stored on membership records so they survive app reinstalls and future auth changes.</li>
        </ul>
        <div class="callout subtle-callout top-gap">Right now the desktop app still uses the beta identity flow. These invite records are the groundwork for replacing it cleanly.</div>
      </article>
    </section>

    ${state.uiMessage ? `<section class="notice notice--${escapeHtml(state.uiMessage.kind)}"><div class="notice-title">${escapeHtml(state.uiMessage.title)}</div><div class="notice-detail">${escapeHtml(state.uiMessage.detail)}</div></section>` : ''}

    ${state.adminApi.lastCreatedInvite ? `
      <section class="panel card">
        <div class="panel-head">
          <h2>Latest invite</h2>
          <span class="tag tag--teal">Created just now</span>
        </div>
        <div class="invite-link-card">
          <div><strong>${escapeHtml(state.adminApi.lastCreatedInvite.email)}</strong> · ${escapeHtml(state.adminApi.lastCreatedInvite.organizationName)}</div>
          <code>${escapeHtml(state.adminApi.lastCreatedInvite.inviteUrl)}</code>
          <div class="button-row top-gap">
            <button class="button-small" id="copy-invite-link" type="button">Copy link</button>
          </div>
        </div>
      </section>
    ` : ''}

    <section class="panel card">
      <div class="panel-head">
        <h2>People in scope</h2>
        <span class="tag tag--navy">Observed + invited</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Name / Email</th>
              <th>Organization</th>
              <th>Onboarding</th>
              <th>Admin role</th>
              <th>In-app extras</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            ${people.map((person) => `
              <tr>
                <td>
                  <div class="cell-title">${escapeHtml(person.name)}</div>
                  <div class="cell-note">${person.email ? escapeHtml(person.email) : `${person.answeredCount} total answers · ${person.pingTouches} ping touches`}</div>
                </td>
                <td>${escapeHtml(person.organization)}</td>
                <td>${escapeHtml(person.membershipStatus || person.onboardingStatus)}</td>
                <td>${person.adminRole ? escapeHtml(person.adminRole) : createPlaceholderBadge()}</td>
                <td>${person.appEntitlements.length ? escapeHtml(person.appEntitlements.join(', ')) : createPlaceholderBadge('None assigned')}</td>
                <td>${escapeHtml(formatRelativeDateLabel(person.lastSeen))}</td>
              </tr>
            `).join('') || `<tr><td colspan="6" class="empty-row">No people matched this filter.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel card">
      <div class="panel-head">
        <h2>Pending invites</h2>
        <span class="tag tag--teal">${invites.length} in scope</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Organization</th>
              <th>Status</th>
              <th>Admin role</th>
              <th>Entitlements</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            ${invites.map((invite) => `
              <tr>
                <td><div class="cell-title">${escapeHtml(invite.email)}</div></td>
                <td>${escapeHtml(invite.organizationName)}</td>
                <td>${escapeHtml(invite.status)}</td>
                <td>${escapeHtml(invite.adminRole || 'member')}</td>
                <td>${invite.appEntitlements?.length ? escapeHtml(invite.appEntitlements.join(', ')) : '—'}</td>
                <td>${escapeHtml(formatTimestamp(parsePossibleDate(invite.createdAt)))}</td>
              </tr>
            `).join('') || `<tr><td colspan="6" class="empty-row">No invite records yet for this scope.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;

  const inviteForm = byId('invite-form');
  if (inviteForm) inviteForm.addEventListener('submit', handleInviteSubmit);

  const copyButton = byId('copy-invite-link');
  if (copyButton) {
    copyButton.addEventListener('click', async () => {
      const url = state.adminApi.lastCreatedInvite?.inviteUrl;
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        state.uiMessage = { kind: 'low', title: 'Invite link copied', detail: 'The latest invite link is now on your clipboard.' };
        renderPage();
      } catch (error) {
        state.uiMessage = { kind: 'medium', title: 'Copy failed', detail: error.message || 'Could not copy the invite link.' };
        renderPage();
      }
    });
  }
}

function renderActivity() {
  const events = buildActivityEvents();
  const filteredEvents = getFilteredEvents();
  const today = getStartOfToday();
  const weekStart = getThisWeekStart();
  const orgs = allOrganizations();

  const answeredToday = events.filter((event) => event.type === 'response_answered' && event.occurredAt >= today).length;
  const pingsThisWeek = events.filter((event) => event.type === 'ping_sent' && event.occurredAt >= weekStart).length;
  const profileSyncsThisWeek = events.filter((event) => event.type === 'profile_synced' && event.occurredAt >= weekStart).length;
  const analysesThisWeek = events.filter((event) => event.type === 'team_analysis_generated' && event.occurredAt >= weekStart).length;
  const invitesThisWeek = events.filter((event) => event.type === 'invite_created' && event.occurredAt >= weekStart).length;

  byId('page-content').innerHTML = `
    <section class="metric-grid metric-grid--five">
      ${metricCard('Answered questions today', answeredToday, 'Live from responses')}
      ${metricCard('Pings this week', pingsThisWeek, 'Live from pings')}
      ${metricCard('Profile syncs this week', profileSyncsThisWeek, 'Live from user profiles')}
      ${metricCard('Analyses this week', analysesThisWeek, 'Live from cached team dashboards')}
      ${metricCard('Invites created this week', invitesThisWeek, state.adminApi.ready ? 'Live from admin invite records' : 'Start local admin API to track invites')}
    </section>

    <section class="panel card">
      <div class="panel-head">
        <div>
          <h2>Summary first</h2>
          <p class="small-copy">The page starts with counts instead of a wall of events. Open the detailed log only when you need it.</p>
        </div>
        <button class="button-small" id="toggle-activity-detail">${state.showDetailedActivity ? 'Hide detailed log' : 'View detailed log'}</button>
      </div>
      ${state.showDetailedActivity ? `
        <div class="filters-row top-gap">
          <label>
            <span>Organization</span>
            <select id="activity-org-filter">
              <option value="all">All organizations</option>
              ${orgs.map((org) => `<option value="${escapeHtml(org.normalized)}" ${org.normalized === state.orgFilter ? 'selected' : ''}>${escapeHtml(org.label)}</option>`).join('')}
            </select>
          </label>
          <label>
            <span>Event type</span>
            <select id="activity-event-filter">
              <option value="all">All event types</option>
              ${Object.entries(eventTypeLabels).map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === state.eventFilter ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="timeline top-gap">
          ${filteredEvents.slice(0, 100).map((event) => `
            <div class="timeline-item">
              <div class="timeline-time">${escapeHtml(formatTimestamp(event.occurredAt))}</div>
              <div>
                <div class="timeline-title">${escapeHtml(event.title)}</div>
                <div class="timeline-detail">${escapeHtml(event.org)} · ${escapeHtml(eventTypeLabels[event.type] || event.type)} · ${escapeHtml(event.detail)}</div>
              </div>
            </div>
          `).join('') || '<div class="empty-state">No events matched the current filters.</div>'}
        </div>
      ` : `
        <div class="callout top-gap">Detailed logs are available here with org and event-type filters, but they stay tucked away until you ask for them.</div>
      `}
    </section>
  `;

  byId('toggle-activity-detail')?.addEventListener('click', () => {
    state.showDetailedActivity = !state.showDetailedActivity;
    updateQueryState();
    renderPage();
  });
  byId('activity-org-filter')?.addEventListener('change', (event) => {
    state.orgFilter = event.target.value;
    updateQueryState();
    renderPage();
  });
  byId('activity-event-filter')?.addEventListener('change', (event) => {
    state.eventFilter = event.target.value;
    updateQueryState();
    renderPage();
  });
}

function renderHealth() {
  byId('page-content').innerHTML = `
    <section class="panel-grid panel-grid--two">
      <article class="panel card">
        <div class="panel-head">
          <h2>Available now</h2>
          <span class="tag tag--teal">Frontend-readable</span>
        </div>
        <div class="availability-grid">
          <div class="availability-row"><span>Organizations</span><strong>Live data</strong></div>
          <div class="availability-row"><span>User profiles</span><strong>Live data</strong></div>
          <div class="availability-row"><span>Responses</span><strong>Live data</strong></div>
          <div class="availability-row"><span>Pings</span><strong>Live data</strong></div>
          <div class="availability-row"><span>AI dashboards</span><strong>Live data</strong></div>
          <div class="availability-row"><span>Invites / memberships</span><strong>${state.adminApi.ready ? 'Live through local admin API' : 'Local admin API not connected'}</strong></div>
        </div>
      </article>

      <article class="panel card">
        <div class="panel-head">
          <h2>Next Firestore additions</h2>
          <span class="tag tag--gold">Still to add</span>
        </div>
        <div class="stack-list">
          <div class="stack-row stack-row--top">
            <div>
              <div class="stack-title">App versions / installs</div>
              <div class="stack-note">Needed for “which version is this org using?” and upgrade prompts.</div>
            </div>
            ${createPlaceholderBadge()}
          </div>
          <div class="stack-row stack-row--top">
            <div>
              <div class="stack-title">Desktop magic-link claim flow</div>
              <div class="stack-note">The admin side can now create invite records, but the desktop app still needs to consume them.</div>
            </div>
            ${createPlaceholderBadge('Next step')}
          </div>
          <div class="stack-row stack-row--top">
            <div>
              <div class="stack-title">Readable support events</div>
              <div class="stack-note">The app can write support events today, but this frontend cannot read them under current rules.</div>
            </div>
            ${createPlaceholderBadge()}
          </div>
        </div>
      </article>
    </section>

    <section class="panel card">
      <div class="panel-head">
        <h2>Load status</h2>
        <span class="tag tag--navy">Local admin prototype</span>
      </div>
      ${state.loadErrors.length ? `
        <div class="notice-list notice-list--single">
          ${state.loadErrors.map((error) => `<div class="notice notice--medium"><div class="notice-title">Data load warning</div><div class="notice-detail">${escapeHtml(error)}</div></div>`).join('')}
        </div>
      ` : `
        <div class="notice notice--low">
          <div class="notice-title">Live collections loaded successfully</div>
          <div class="notice-detail">This page is reading what it can directly from Firestore and using the local admin API for protected invite writes.</div>
        </div>
      `}
      ${state.adminApi.error ? `
        <div class="notice notice--medium top-gap">
          <div class="notice-title">Local admin API not connected</div>
          <div class="notice-detail">${escapeHtml(state.adminApi.error)}. Start the local admin API to enable invite creation and membership writes.</div>
        </div>
      ` : ''}
    </section>
  `;
}

function renderPage() {
  renderTopShell();
  if (state.page === 'dashboard') return renderOverview();
  if (state.page === 'organizations') return renderOrganizations();
  if (state.page === 'people') return renderPeople();
  if (state.page === 'activity') return renderActivity();
  return renderHealth();
}

function bindShellEvents() {
  byId('org-switcher')?.addEventListener('change', (event) => {
    state.orgFilter = event.target.value;
    updateQueryState();
    renderPage();
  });
}

async function refreshAdminApiAfterInvite() {
  await loadAdminApiData();
}

async function handleInviteSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const appEntitlements = formData.getAll('appEntitlements');
  const payload = {
    email: String(formData.get('email') || '').trim(),
    organizationId: String(formData.get('organizationId') || '').trim(),
    adminRole: String(formData.get('adminRole') || 'member'),
    appEntitlements,
    createdBy: fallbackAppInfo.signedInAs
  };

  try {
    const response = await fetch(`${ADMIN_API_BASE}/api/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);

    state.adminApi.lastCreatedInvite = result.invite;
    state.uiMessage = {
      kind: 'low',
      title: 'Invite created',
      detail: `Created a pending magic-link invite for ${result.invite.email} in ${result.invite.organizationName}.`
    };
    form.reset();
    await refreshAdminApiAfterInvite();
    renderPage();
  } catch (error) {
    state.uiMessage = {
      kind: 'medium',
      title: 'Invite creation failed',
      detail: error.message || 'Something went wrong while creating the invite.'
    };
    renderPage();
  }
}

async function init() {
  applyQueryState();
  renderTopShell();
  bindShellEvents();
  byId('page-content').innerHTML = '<section class="panel card"><div class="loading-state">Loading admin data…</div></section>';
  await Promise.all([loadLiveData(), loadAdminApiData()]);
  renderPage();
  bindShellEvents();
}

document.addEventListener('DOMContentLoaded', init);
