const statusElement = document.getElementById("status");
const loginForm = document.getElementById("login-form");
const uploadPanel = document.getElementById("upload-panel");
const uploadButton = document.getElementById("upload-button");

function showStatus(message, type) {
  statusElement.textContent = message;
  statusElement.className = `status is-visible is-${type}`;
}

async function requestJson(url, options) {
  let response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...options
    });
  } catch {
    throw new Error("Não foi possível conectar ao servidor local do dashboard.");
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("O servidor retornou uma resposta inesperada. Recarregue o painel administrativo.");
  }

  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Solicitação recusada (${response.status}).`);
  return body;
}

function showLogin() {
  loginForm.hidden = false;
  uploadPanel.hidden = true;
}

function showUpload() {
  loginForm.hidden = true;
  uploadPanel.hidden = false;
}

async function loadSession() {
  const session = await requestJson("/api/admin/session");
  if (!session.configured) {
    showLogin();
    document.getElementById("password").disabled = true;
    loginForm.querySelector("button").disabled = true;
    showStatus(
      "A área de atualização ainda não está configurada. Inicie o servidor com ADMIN_PASSWORD definida no PowerShell; consulte o README.",
      "error"
    );
    return;
  }

  if (session.authenticated) showUpload();
  else showLogin();
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = loginForm.querySelector("button");
  button.disabled = true;

  try {
    await requestJson("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: document.getElementById("password").value })
    });
    document.getElementById("password").value = "";
    showStatus("Acesso autorizado. Sua sessão expira após 8 horas.", "success");
    showUpload();
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

document.getElementById("logout-button").addEventListener("click", async () => {
  try {
    await requestJson("/api/admin/logout", { method: "POST" });
    showLogin();
    showStatus("Sessão encerrada.", "info");
  } catch (error) {
    showStatus(error.message, "error");
  }
});

document.getElementById("upload-form").addEventListener("submit", async event => {
  event.preventDefault();
  const file = document.getElementById("spreadsheet").files[0];
  if (!file) {
    showStatus("Selecione uma planilha para continuar.", "error");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showStatus("O limite por arquivo é de 10 MB.", "error");
    return;
  }

  uploadButton.disabled = true;
  showStatus("Validando a planilha e atualizando o banco...", "info");
  try {
    const result = await requestJson("/api/admin/import", {
      method: "POST",
      headers: { "X-File-Name": encodeURIComponent(file.name) },
      body: file
    });
    showStatus(
      `Importação concluída: ${result.added} novos e ${result.updated} atualizados em ${result.weeks} semana(s). Recarregue o dashboard para ver as alterações.`,
      "success"
    );
    event.target.reset();
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    uploadButton.disabled = false;
  }
});

loadSession().catch(error => showStatus(error.message, "error"));
