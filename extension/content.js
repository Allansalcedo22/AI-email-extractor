// Injected on demand by the side panel via chrome.scripting.executeScript.
// The value of the final expression (the IIFE's return) is sent back to the panel:
//   { source, text, subject, messageCount, truncated }
//
// Order of preference:
//   1. Text the user has highlighted.
//   2. The open email/thread in Gmail, Yahoo Mail, or Outlook (sender + body per message).
//   3. The page's main content (article/main), falling back to <body>.
//
// Webmail DOM class names are undocumented and change over time. Every site
// extractor returns null when its selectors don't match, so we fall through
// to the generic extractor instead of failing.

(() => {
  const MAX_CHARS = 30000;

  /** Visible text of an element, with runs of blank lines collapsed. */
  const clean = (s) =>
    (s || "")
      .replace(/ /g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const textOf = (el) => clean(el ? el.innerText : "");

  /** Join messages into a thread the backend can read, oldest first. */
  function formatThread(subject, messages) {
    const parts = messages.map((m) => {
      const head = [];
      if (m.from) head.push(`From: ${m.from}`);
      if (m.to) head.push(`To: ${m.to}`);
      if (m.date) head.push(`Date: ${m.date}`);
      return [head.join("\n"), m.body].filter(Boolean).join("\n\n");
    });
    const thread = parts.join("\n\n---\n\n");
    return subject ? `Subject: ${subject}\n\n${thread}` : thread;
  }

  function fromSelection() {
    const sel = window.getSelection();
    const text = clean(sel ? sel.toString() : "");
    return text.length >= 2 ? { source: "selection", text } : null;
  }

  function fromGmail() {
    if (location.hostname !== "mail.google.com") return null;
    // Each expanded message in a conversation is a .adn; its body is .a3s.
    const containers = [...document.querySelectorAll("div.adn")].filter((c) => c.querySelector("div.a3s"));
    if (!containers.length) return null;
    const messages = containers
      .map((c) => {
        const sender = c.querySelector("span.gD");
        const from = sender
          ? [sender.getAttribute("name") || sender.innerText, sender.getAttribute("email")].filter(Boolean).join(" ").replace(/ (\S+@\S+)$/, " <$1>")
          : "";
        const to = [...c.querySelectorAll("span.g2")].map((s) => s.getAttribute("name") || s.innerText).filter(Boolean).join(", ");
        const dateEl = c.querySelector("span.g3");
        const date = dateEl ? dateEl.getAttribute("title") || dateEl.innerText : "";
        return { from, to, date, body: textOf(c.querySelector("div.a3s")) };
      })
      .filter((m) => m.body);
    if (!messages.length) return null;
    const subject = textOf(document.querySelector("h2.hP"));
    return { source: "gmail", subject, messageCount: messages.length, text: formatThread(subject, messages) };
  }

  function fromYahoo() {
    if (!/(^|\.)mail\.yahoo\.com$/.test(location.hostname)) return null;
    const bodies = [...document.querySelectorAll('[data-test-id="message-view-body-content"]')];
    if (!bodies.length) return null;
    const messages = bodies
      .map((body) => {
        const view = body.closest('[data-test-id="message-view"]') || body.parentElement;
        const fromEl = view && view.querySelector('[data-test-id="message-from"]');
        const dateEl = view && view.querySelector('[data-test-id="message-date"]');
        return { from: textOf(fromEl), date: textOf(dateEl), body: textOf(body) };
      })
      .filter((m) => m.body);
    if (!messages.length) return null;
    const subject = textOf(document.querySelector('[data-test-id="message-group-subject-text"]'));
    return { source: "yahoo", subject, messageCount: messages.length, text: formatThread(subject, messages) };
  }

  function fromOutlook() {
    if (!/^outlook\.(live|office|office365)\.com$/.test(location.hostname)) return null;
    const bodies = [...document.querySelectorAll('div[aria-label="Message body"]')];
    if (!bodies.length) return null;
    const messages = bodies.map((body) => ({ body: textOf(body) })).filter((m) => m.body);
    if (!messages.length) return null;
    const pane = document.querySelector('[role="main"]');
    const heading = pane && pane.querySelector('[role="heading"]');
    const subject = textOf(heading);
    return { source: "outlook", subject, messageCount: messages.length, text: formatThread(subject, messages) };
  }

  function fromPage() {
    const candidates = ["article", '[role="article"]', "main", '[role="main"]'];
    for (const sel of candidates) {
      const text = textOf(document.querySelector(sel));
      if (text.length >= 200) return { source: "page", subject: document.title, text };
    }
    return { source: "page", subject: document.title, text: textOf(document.body) };
  }

  const result = fromSelection() || fromGmail() || fromYahoo() || fromOutlook() || fromPage();
  result.truncated = result.text.length > MAX_CHARS;
  if (result.truncated) result.text = result.text.slice(0, MAX_CHARS);
  return result;
})();
