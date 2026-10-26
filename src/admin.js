import {
  getHostAuthStatus,
  getStorageMode,
  lockHostSession,
  loginHostPasskey,
  registerPasskeyAccount,
} from "./store.js";

const app = document.querySelector("#admin-app");
const toast = document.querySelector("#admin-toast");
let toastTimer;
let adminEventsBound = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message, kind = "success") {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("error", kind === "error");
  toast.classList.add("visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Request failed (${response.status}).`);
  }
  return body;
}

function renderSetup(auth) {
  app.innerHTML = `
    <section class="admin-auth">
      <div class="admin-auth-card">
        <h1>Create administrator</h1>
        <p>The bootstrap token is required once to secure the system administrator account.</p>
        <form class="admin-form" id="setup-form">
          <label><span>Admin username</span><input name="username" autocomplete="username" required /></label>
          <label><span>Display name</span><input name="displayName" autocomplete="name" required /></label>
          <label><span>Bootstrap token</span><input name="token" type="password" required /></label>
          <button class="admin-button primary" type="submit">Create admin passkey</button>
        </form>
      </div>
    </section>
  `;
  document.querySelector("#setup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    try {
      const data = new FormData(event.target);
      await registerPasskeyAccount({
        username: data.get("username"),
        displayName: data.get("displayName"),
        registrationToken: data.get("token"),
      });
      await startAdmin();
    } catch (error) {
      showToast(error.message || "Administrator setup failed.", "error");
      submit.disabled = false;
    }
  });
}

function renderLogin() {
  app.innerHTML = `
    <section class="admin-auth">
      <div class="admin-auth-card">
        <h1>Administrator sign-in</h1>
        <p>Only the system administrator account can access this console.</p>
        <form class="admin-form" id="login-form">
          <label><span>Admin username</span><input name="username" autocomplete="username" required /></label>
          <button class="admin-button primary" type="submit">Continue with passkey</button>
        </form>
        <p><a class="back-link" href="../">Return to budgeting site</a></p>
      </div>
    </section>
  `;
  document.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    try {
      const username = new FormData(event.target).get("username");
      await loginHostPasskey(username);
      await startAdmin();
    } catch (error) {
      showToast(error.message || "Administrator sign-in failed.", "error");
      submit.disabled = false;
    }
  });
}

function renderDenied(displayName) {
  app.innerHTML = `
    <section class="admin-auth">
      <div class="admin-auth-card">
        <h1>Access denied</h1>
        <p>${escapeHtml(displayName)} is a valid Budget Cal user but is not the system administrator.</p>
        <button class="admin-button secondary" id="admin-signout" type="button">Sign out</button>
      </div>
    </section>
  `;
  document.querySelector("#admin-signout").addEventListener("click", signOut);
}

async function signOut() {
  try {
    await lockHostSession();
    renderLogin();
  } catch (error) {
    showToast(error.message || "Could not sign out.", "error");
  }
}

async function startAdmin() {
  const auth = await getHostAuthStatus();
  if (!auth.authenticated) {
    renderLogin();
    return;
  }
  if (!auth.user?.isAdmin) {
    renderDenied(auth.user?.displayName || "This account");
    return;
  }
  await renderDashboard(auth.user);
}

async function loadAdminData() {
  const [users, workspaces, invitations] = await Promise.all([
    api("../api/admin/users"),
    api("../api/admin/workspaces"),
    api("../api/admin/invitations"),
  ]);
  const memberships = await Promise.all(
    workspaces.workspaces.map((workspace) =>
      api(`../api/admin/workspaces/${encodeURIComponent(workspace.workspaceId)}/members`),
    ),
  );
  return {
    users: users.users,
    workspaces: workspaces.workspaces.map((workspace, index) => ({
      ...workspace,
      members: memberships[index].members,
    })),
    invitations: invitations.invitations,
  };
}

async function renderDashboard(admin) {
  const data = await loadAdminData();
  app.innerHTML = `
    <header class="admin-header">
      <div class="page-title">
        <h1>System control</h1>
        <p>Signed in as ${escapeHtml(admin.displayName)} · @${escapeHtml(admin.username)}</p>
      </div>
      <button class="admin-button secondary" id="admin-signout" type="button">Sign out</button>
    </header>

    <section class="admin-grid">
      <article class="admin-card">
        <h2>Users</h2>
        <div class="item-list">
          ${data.users
            .map(
              (user) => `
                <div class="admin-item">
                  <div>
                    <strong>${escapeHtml(user.displayName)} ${user.isAdmin ? '<span class="tag admin">admin</span>' : ""} ${user.isDisabled ? '<span class="tag disabled">disabled</span>' : ""}</strong>
                    <small>@${escapeHtml(user.username)} · ${user.passkeyCount} passkeys · ${user.workspaceCount} workspaces</small>
                  </div>
                  ${
                    user.isAdmin
                      ? ""
                      : `<button class="admin-button ${user.isDisabled ? "secondary" : "danger"}" type="button" data-toggle-user="${escapeHtml(user.id)}" data-disabled="${user.isDisabled ? "false" : "true"}">
                          ${user.isDisabled ? "Enable" : "Disable"}
                        </button>`
                  }
                </div>
              `,
            )
            .join("")}
        </div>
      </article>

      <article class="admin-card">
        <h2>Create workspace</h2>
        <form class="inline-form" id="workspace-form">
          <input name="name" maxlength="80" placeholder="Household or project name" required />
          <button class="admin-button primary" type="submit">Create</button>
        </form>
        <h3>Pending invitations</h3>
        <div class="item-list">
          ${
            data.invitations.length
              ? data.invitations
                  .map(
                    (invitation) => `
                      <div class="admin-item">
                        <div>
                          <strong>${escapeHtml(invitation.workspaceName)} · ${escapeHtml(invitation.role)}</strong>
                          <small>Expires ${escapeHtml(new Date(invitation.expiresAt).toLocaleDateString())}</small>
                        </div>
                        <button class="admin-button danger" type="button" data-revoke-invite="${escapeHtml(invitation.id)}">Revoke</button>
                      </div>
                    `,
                  )
                  .join("")
              : '<p class="page-title"><small>No pending invitations.</small></p>'
          }
        </div>
        <div id="invite-result"></div>
      </article>
    </section>

    ${data.workspaces
      .map(
        (workspace) => `
          <section class="admin-card workspace-admin">
            <div class="workspace-admin-header">
              <div>
                <h2>${escapeHtml(workspace.workspaceName)}</h2>
                <small>${workspace.memberCount} members · ${workspace.pendingInvitationCount} pending invites</small>
              </div>
              <div class="workspace-admin-actions">
                <form class="inline-form workspace-invite-form" data-workspace-id="${escapeHtml(workspace.workspaceId)}">
                  <select name="role">
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button class="admin-button primary" type="submit">Create invite</button>
                </form>
                <button
                  class="admin-button danger"
                  type="button"
                  data-delete-workspace="${escapeHtml(workspace.workspaceId)}"
                  data-workspace-name="${escapeHtml(workspace.workspaceName)}"
                >
                  Delete workspace
                </button>
              </div>
            </div>
            <div class="member-list">
              ${workspace.members
                .map(
                  (member) => `
                    <div class="member-row">
                      <div>
                        <strong>${escapeHtml(member.displayName)}</strong>
                        <small>@${escapeHtml(member.username)}</small>
                      </div>
                      ${
                        member.role === "owner"
                          ? '<span class="owner-label">Owner</span>'
                          : `<select data-member-workspace="${escapeHtml(workspace.workspaceId)}" data-member-id="${escapeHtml(member.id)}">
                              <option value="editor" ${member.role === "editor" ? "selected" : ""}>Editor</option>
                              <option value="viewer" ${member.role === "viewer" ? "selected" : ""}>Viewer</option>
                            </select>
                            <button class="admin-button danger" type="button" data-remove-member="${escapeHtml(member.id)}" data-workspace-id="${escapeHtml(workspace.workspaceId)}">Remove</button>`
                      }
                    </div>
                  `,
                )
                .join("")}
            </div>
          </section>
        `,
      )
      .join("")}
  `;

  document.querySelector("#admin-signout").addEventListener("click", signOut);
  document.querySelector("#workspace-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    try {
      await api("../api/admin/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: new FormData(event.target).get("name") }),
      });
      showToast("Workspace created.");
      await renderDashboard(admin);
    } catch (error) {
      showToast(error.message, "error");
      submit.disabled = false;
    }
  });

  if (!adminEventsBound) {
    app.addEventListener("click", adminClickHandler);
    app.addEventListener("change", adminChangeHandler);
    app.addEventListener("submit", adminSubmitHandler);
    adminEventsBound = true;
  }
}

async function adminClickHandler(event) {
  const button = event.target.closest("button[data-toggle-user], button[data-remove-member], button[data-revoke-invite], button[data-copy-invite], button[data-delete-workspace]");
  if (!button) return;
  try {
    if (button.hasAttribute("data-copy-invite")) {
      const input = document.querySelector("#new-invite-link");
      await navigator.clipboard.writeText(input.value);
      showToast("Invitation link copied.");
      return;
    } else if (button.dataset.deleteWorkspace) {
      const expectedName = button.dataset.workspaceName;
      const confirmation = window.prompt(
        `This permanently deletes the workspace, its encrypted data, memberships, and invitations.\n\nType "${expectedName}" to continue:`,
      );
      if (confirmation !== expectedName) {
        showToast("Workspace deletion cancelled.", "error");
        return;
      }
      await api(
        `../api/admin/workspaces/${encodeURIComponent(button.dataset.deleteWorkspace)}`,
        { method: "DELETE" },
      );
      showToast("Workspace deleted.");
    } else if (button.dataset.toggleUser) {
      await api(`../api/admin/users/${encodeURIComponent(button.dataset.toggleUser)}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled: button.dataset.disabled === "true" }),
      });
      showToast("User status updated.");
    } else if (button.dataset.removeMember) {
      if (!window.confirm("Remove this member from the workspace?")) return;
      await api(
        `../api/admin/workspaces/${encodeURIComponent(button.dataset.workspaceId)}/members/${encodeURIComponent(button.dataset.removeMember)}`,
        { method: "DELETE" },
      );
      showToast("Member removed.");
    } else if (button.dataset.revokeInvite) {
      await api(`../api/admin/invitations/${encodeURIComponent(button.dataset.revokeInvite)}`, {
        method: "DELETE",
      });
      showToast("Invitation revoked.");
    }
    await startAdmin();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function adminSubmitHandler(event) {
  const form = event.target.closest(".workspace-invite-form");
  if (!form) return;
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const result = await api("../api/admin/invitations", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: form.dataset.workspaceId,
        role: new FormData(form).get("role"),
      }),
    });
    document.querySelector("#invite-result").innerHTML = `
      <div class="invite-result">
        <strong>Invitation link</strong>
        <input id="new-invite-link" readonly value="${escapeHtml(result.url)}" />
        <button class="admin-button secondary" type="button" data-copy-invite>Copy link</button>
      </div>
    `;
    showToast("Invitation created.");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    submit.disabled = false;
  }
}

async function adminChangeHandler(event) {
  const select = event.target.closest("select[data-member-id]");
  if (!select) return;
  try {
    await api(
      `../api/admin/workspaces/${encodeURIComponent(select.dataset.memberWorkspace)}/members/${encodeURIComponent(select.dataset.memberId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ role: select.value }),
      },
    );
    showToast("Member role updated.");
  } catch (error) {
    showToast(error.message, "error");
    await startAdmin();
  }
}

async function init() {
  try {
    const storage = await getStorageMode();
    if (storage !== "mysql") {
      throw new Error("MySQL multi-user mode is not enabled.");
    }
    const auth = await getHostAuthStatus();
    if (!auth.registered) {
      renderSetup(auth);
    } else if (!auth.authenticated) {
      renderLogin();
    } else if (!auth.user?.isAdmin) {
      renderDenied(auth.user?.displayName || "This account");
    } else {
      await renderDashboard(auth.user);
    }
  } catch (error) {
    app.innerHTML = `<section class="admin-auth"><div class="admin-auth-card"><h1>Admin console unavailable</h1><p>${escapeHtml(error.message)}</p></div></section>`;
  }
}

init();
