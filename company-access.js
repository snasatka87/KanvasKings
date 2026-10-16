"use strict";

const accessTabs = Array.from(document.querySelectorAll(".access-tab"));
const accessPanels = Array.from(document.querySelectorAll(".access-form"));
const supabaseState = window.kanvasSupabase;
const registerForm = document.querySelector("#register-panel");
const loginForm = document.querySelector("#login-panel");
const registerStatus = document.querySelector("#register-status");
const loginStatus = document.querySelector("#login-status");

function activateAccessTab(tab) {
  const selectedPanel = document.getElementById(tab.getAttribute("aria-controls"));
  accessTabs.forEach((item) => {
    const selected = item === tab;
    item.classList.toggle("is-active", selected);
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  });
  accessPanels.forEach((panel) => {
    panel.hidden = panel !== selectedPanel;
    panel.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ""; });
    const status = panel.querySelector(".access-status");
    if (status) status.textContent = "";
  });
  document.querySelector("#access-title").textContent = tab.id === "register-tab" ? "Get your team started" : "Welcome back";
  document.querySelector("#access-description").textContent = tab.id === "register-tab"
    ? "Create an account and create or join a company workspace."
    : "Log in and connect to your company workspace.";
}

function setAccessStatus(target, message, isError = false) {
  target.textContent = message;
  target.classList.toggle("error", isError);
}

function requireSupabase(target) {
  if (supabaseState?.client) return true;
  setAccessStatus(target, supabaseState?.configurationError || "Supabase could not be initialized.", true);
  return false;
}

function workspaceError(error) {
  return error?.message || "Could not connect to the company workspace. Please try again.";
}

async function connectCompany(client, action, company, joinCode) {
  const procedure = action === "create" ? "create_company" : "join_company";
  const { data, error } = await client.rpc(procedure, {
    p_company_name: company,
    p_join_code: joinCode,
  });
  if (error) throw error;
  if (!data?.company_id || !data?.company_name) throw new Error("Company workspace setup returned incomplete data.");
  return data;
}

accessTabs.forEach((tab) => {
  tab.addEventListener("click", () => activateAccessTab(tab));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextTab = accessTabs[(accessTabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : accessTabs.length - 1)) % accessTabs.length];
    activateAccessTab(nextTab);
    nextTab.focus();
  });
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireSupabase(registerStatus)) return;
  const form = new FormData(registerForm);
  const company = String(form.get("company") || "").trim();
  const fullName = String(form.get("name") || "").trim();
  const email = String(form.get("email") || "").trim();
  const password = String(form.get("password") || "");
  const joinCode = String(form.get("joinCode") || "");
  const action = String(form.get("action") || "join");
  const submit = registerForm.querySelector('[type="submit"]');
  submit.disabled = true;
  setAccessStatus(registerStatus, "Creating your account…");
  try {
    const { data, error } = await supabaseState.client.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: new URL("company-access.html", location.href).href,
      },
    });
    if (error) throw error;
    document.querySelector("#register-password").value = "";
    if (!data.session) {
      setAccessStatus(registerStatus, "Account created. Check your email to confirm it, then log in with the same company name and join code to finish workspace setup.");
      return;
    }
    try {
      await connectCompany(supabaseState.client, action, company, joinCode);
      location.assign("./index.html");
    } catch (error) {
      const { error: signOutError } = await supabaseState.client.auth.signOut();
      if (signOutError) throw new Error(`${workspaceError(error)} Sign-out also failed: ${signOutError.message}`);
      throw error;
    }
  } catch (error) {
    setAccessStatus(registerStatus, workspaceError(error), true);
  } finally {
    document.querySelector("#register-password").value = "";
    submit.disabled = false;
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireSupabase(loginStatus)) return;
  const form = new FormData(loginForm);
  const email = String(form.get("email") || "").trim();
  const password = String(form.get("password") || "");
  const company = String(form.get("company") || "").trim();
  const joinCode = String(form.get("joinCode") || "");
  const action = String(form.get("action") || "join");
  const submit = loginForm.querySelector('[type="submit"]');
  submit.disabled = true;
  setAccessStatus(loginStatus, "Signing in and opening your workspace…");
  try {
    const { error } = await supabaseState.client.auth.signInWithPassword({ email, password });
    document.querySelector("#login-password").value = "";
    if (error) throw error;
    try {
      await connectCompany(supabaseState.client, action, company, joinCode);
      location.assign("./index.html");
    } catch (error) {
      const { error: signOutError } = await supabaseState.client.auth.signOut();
      if (signOutError) throw new Error(`${workspaceError(error)} Sign-out also failed: ${signOutError.message}`);
      throw error;
    }
  } catch (error) {
    setAccessStatus(loginStatus, workspaceError(error), true);
  } finally {
    document.querySelector("#login-password").value = "";
    submit.disabled = false;
  }
});

const search = new URLSearchParams(location.search);
if (search.get("message") === "workspace") {
  activateAccessTab(document.querySelector("#login-tab"));
  setAccessStatus(loginStatus, "Your account is signed in, but it is not connected to a company workspace. Enter the exact company name and private join code, then choose the correct workspace action.");
}
