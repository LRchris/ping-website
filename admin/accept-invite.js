const ADMIN_API_BASE = (() => {
  const override = (localStorage.getItem('ping_admin_api_base') || '').trim();
  return (override || 'http://localhost:4180').replace(/\/$/, '');
})();

const app = document.getElementById('invite-app');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getToken() {
  return new URLSearchParams(window.location.search).get('token') || '';
}

function renderMessage(title, detail, kind = 'low') {
  app.innerHTML = `
    <div class="notice notice--${escapeHtml(kind)}">
      <div class="notice-title">${escapeHtml(title)}</div>
      <div class="notice-detail">${escapeHtml(detail)}</div>
    </div>
  `;
}

function renderInvite(invite, membership, lifecycleState) {
  const claimable = lifecycleState === 'pending';
  app.innerHTML = `
    <div class="page-title-wrap">
      <div class="breadcrumb-line">Invite for ${escapeHtml(invite.organizationName)}</div>
      <h1>${claimable ? 'You are invited to Ping' : 'Invite status'}</h1>
      <p>${claimable ? 'Claim this invite so your membership record is ready before you open the desktop app.' : 'This invite already has a final state.'}</p>
    </div>

    <section class="panel card top-gap">
      <div class="detail-grid">
        <div><span class="detail-label">Email</span><strong>${escapeHtml(invite.email)}</strong></div>
        <div><span class="detail-label">Organization</span><strong>${escapeHtml(invite.organizationName)}</strong></div>
        <div><span class="detail-label">Admin role</span><strong>${escapeHtml(invite.adminRole || 'member')}</strong></div>
        <div><span class="detail-label">In-app extras</span><strong>${invite.appEntitlements?.length ? escapeHtml(invite.appEntitlements.join(', ')) : 'None'}</strong></div>
      </div>
    </section>

    ${claimable ? `
      <section class="panel card top-gap">
        <div class="panel-head">
          <h2>Claim your invite</h2>
          <span class="tag tag--teal">Ready</span>
        </div>
        <form id="claim-form" class="invite-form">
          <label>
            <span>Your name</span>
            <input type="text" name="displayName" placeholder="How should Ping label you?" />
          </label>
          <button class="button-small" type="submit">Claim invite</button>
        </form>
      </section>
    ` : `
      <section class="panel card top-gap">
        <div class="panel-head">
          <h2>${escapeHtml(lifecycleState.charAt(0).toUpperCase() + lifecycleState.slice(1))}</h2>
          <span class="tag">${escapeHtml(lifecycleState)}</span>
        </div>
        <p class="panel-copy">
          ${lifecycleState === 'claimed'
            ? `This invite was already claimed${membership?.displayName ? ` by ${membership.displayName}` : ''}.`
            : lifecycleState === 'revoked'
              ? 'This invite was revoked by an admin.'
              : 'This invite is no longer valid.'}
        </p>
      </section>
    `}

    <section class="panel card top-gap">
      <div class="panel-head">
        <h2>What happens next</h2>
      </div>
      <ul class="plain-list">
        <li>Your org-bound membership record is stored in Firestore.</li>
        <li>Your role and entitlements stay attached to your membership.</li>
        <li>The desktop app auth handoff is the next piece we will wire to this invite flow.</li>
      </ul>
    </section>
  `;

  const form = document.getElementById('claim-form');
  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const displayName = String(formData.get('displayName') || '').trim();
      form.querySelector('button').disabled = true;
      try {
        const response = await fetch(`${ADMIN_API_BASE}/api/invites/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: getToken(),
            displayName
          })
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
        renderMessage(
          'Invite claimed',
          `You're set for ${result.invite.organizationName}. The membership record is now active${displayName ? ` for ${displayName}` : ''}.`,
          'low'
        );
      } catch (error) {
        renderMessage('Claim failed', error.message || 'Could not claim this invite.', 'medium');
      }
    });
  }
}

async function init() {
  const token = getToken();
  if (!token) {
    renderMessage('Invite link missing', 'This link does not include an invite token.', 'medium');
    return;
  }

  try {
    const response = await fetch(`${ADMIN_API_BASE}/api/invites/resolve?token=${encodeURIComponent(token)}`);
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
    renderInvite(result.invite, result.membership, result.lifecycleState);
  } catch (error) {
    renderMessage('Invite not available', error.message || 'Could not load this invite.', 'medium');
  }
}

document.addEventListener('DOMContentLoaded', init);
