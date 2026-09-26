/*
 * Runs at the start of every page the phone app shows from the owner's Branch. Its text carries no
 * secret: before opening Branch the native side loads one harmless file from the paired address and
 * writes, into that address's own session storage, the key (as public/pair.js does after pairing) and
 * a small `branch-phone` note that holds this phone's own secret. Any script on the paired address can
 * read both, as in a phone browser; keeping them out of the page would need the native side to add
 * the headers itself (a later brief). Only the paired address has the note, so on any other page this
 * does nothing. With the note it does three small things:
 *   1. adds this phone's own secret to the window's requests, for the "this exact phone" step;
 *   2. tells the app which theme and mode the window shows, so the phone's own screens match;
 *   3. puts one button in the title bar that goes back to the phone's own screen, and opens the
 *      place the phone asked for.
 */
(function () {
  "use strict";
  var config = null;
  try { config = JSON.parse(sessionStorage.getItem("branch-phone") || "null"); } catch (error) { config = null; }
  if (!config || typeof config !== "object") return;

  function post(message) {
    var text = JSON.stringify(message);
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.branchPhone) window.webkit.messageHandlers.branchPhone.postMessage(text);
      else if (window.branchPhone) window.branchPhone.postMessage(text);
    } catch (error) { /* the app is closing */ }
  }

  var sameOrigin = function (url) {
    try { return new URL(String(url), location.href).origin === location.origin; } catch (error) { return false; }
  };
  if (config.deviceId && config.deviceKey) {
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = input && typeof input === "object" && "url" in input ? input.url : input;
      if (!sameOrigin(url)) return originalFetch.call(this, input, init);
      var headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
      headers.set("x-branch-device", config.deviceId);
      headers.set("x-branch-device-key", config.deviceKey);
      return originalFetch.call(this, input, Object.assign({}, init, { headers: headers }));
    };
    var originalOpen = XMLHttpRequest.prototype.open, originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__branchSame = sameOrigin(url);
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (this.__branchSame) {
        this.setRequestHeader("x-branch-device", config.deviceId);
        this.setRequestHeader("x-branch-device-key", config.deviceKey);
      }
      return originalSend.apply(this, arguments);
    };
  }

  function reportLook() {
    var root = document.documentElement;
    post({ type: "look", theme: root.dataset.palette || "slate", mode: root.dataset.theme === "daylight" ? "light" : "dark" });
  }
  function addHomeButton() {
    var connection = document.getElementById("connection");
    if (!connection || document.getElementById("phone-home")) return;
    var button = document.createElement("button");
    button.type = "button";
    button.id = "phone-home";
    button.className = "head-icon";
    button.setAttribute("aria-label", (config.home || "Back to the phone app"));
    button.title = (config.home || "Back to the phone app");
    var mark = document.createElement("img");
    mark.src = "/assets/icon-192.png";
    mark.alt = "";
    mark.style.width = "20px";
    mark.style.height = "20px";
    button.appendChild(mark);
    button.addEventListener("click", function () { post({ type: "home" }); });
    connection.parentNode.insertBefore(button, connection);
  }
  function whenReady() {
    addHomeButton();
    reportLook();
    new MutationObserver(reportLook).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });
    if (config.at && window.branchLayout && typeof window.branchLayout.go === "function") window.branchLayout.go(config.at);
    config.at = "";
    try { sessionStorage.setItem("branch-phone", JSON.stringify(config)); } catch (error) { /* the place opens again next time */ }
  }
  function waitForLayout() {
    if (document.body && document.body.classList.contains("lx-ready")) { whenReady(); return; }
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if ((document.body && document.body.classList.contains("lx-ready")) || tries > 100) { clearInterval(timer); whenReady(); }
    }, 100);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", waitForLayout);
  else waitForLayout();
})();
