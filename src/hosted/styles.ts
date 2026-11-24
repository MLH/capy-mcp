import { createHash } from "node:crypto";

export const hostedStyles = `
:root {
  color-scheme: light;
  --navy: #122f4c;
  --ink: #0c2547;
  --blue: #1d539f;
  --yellow: #f8b92a;
  --red: #e73727;
  --danger: #a92b20;
  --paper: #faf7ed;
  --line: #d9e0e9;
  --wash: #eef4fc;
  --mono: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font: 100%/1.55 system-ui, sans-serif;
}

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  padding: clamp(1rem, 5vw, 3.5rem) clamp(1rem, 4vw, 2rem);
  background-color: var(--paper);
  background-image: linear-gradient(#1d539f0d 1px, transparent 1px),
    linear-gradient(90deg, #1d539f0d 1px, transparent 1px);
  background-size: 24px 24px;
  color: var(--navy);
}

main {
  width: min(100%, 44rem);
  margin-inline: auto;
  padding: clamp(1.25rem, 5vw, 2.5rem);
  border: 1px solid var(--line);
  border-radius: 0.625rem;
  background: #fff;
  box-shadow: 0 6px 0 #122f4c0d, 0 16px 36px #122f4c0a;
  overflow-wrap: anywhere;
}

.wordmark {
  display: inline-flex;
  align-items: center;
  gap: 0.65rem;
  font: 700 0.8125rem/1.2 var(--mono);
  letter-spacing: 0.12em;
  color: var(--blue);
}

.wordmark::before {
  content: "";
  width: 2.25rem;
  height: 0.375rem;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--blue) 33.333%, var(--yellow) 33.333% 66.667%, var(--red) 66.667%);
}

h1, h2 {
  font-family: var(--mono);
  line-height: 1.2;
  color: var(--ink);
}

h1 {
  margin: 0.7rem 0 1.125rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--line);
  font-size: clamp(1.65rem, 4.2vw, 2.25rem);
  letter-spacing: -0.055em;
}

h2 { margin: 0 0 0.75rem; font-size: 1.125rem; letter-spacing: -0.025em; }
p { margin: 0.875rem 0; }
main > :last-child, section > :last-child, li > :last-child { margin-bottom: 0; }

section {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--line);
}

a { color: var(--blue); font-weight: 650; text-underline-offset: 0.2em; }
a:hover { text-decoration-thickness: 2px; }
a.danger { color: var(--danger); }

label, code, .status { font-family: var(--mono); }

.status, .scopes code, .grants code {
  padding: 0.15em 0.5em;
  border-radius: 1em;
  background: var(--wash);
  color: var(--blue);
  font-size: 0.875em;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}

.notice {
  padding: 0.75rem 0.875rem;
  border-inline-start: 3px solid var(--yellow);
  border-radius: 0.25rem;
  background-color: #fff8e6;
}

.grants { list-style: none; padding: 0; margin: 0.875rem 0; }
.grants li { padding: 0.875rem; border: 1px solid var(--line); border-radius: 0.375rem; }
.grants li + li { margin-top: 0.625rem; }
.grants p { margin: 0 0 0.45rem; }
.grant-date { display: inline-block; max-width: 100%; }

form { margin: 1rem 0 0; }
label { font-weight: 650; }

input[type="password"] {
  display: block;
  width: 100%;
  min-height: 2.75rem;
  margin-top: 0.45rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid #657c96;
  border-radius: 0.375rem;
  font: inherit;
  color: var(--ink);
  background: #fff;
}

.choice {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  margin-bottom: 1rem;
  padding: 0.75rem 0.875rem;
  border: 1px solid var(--line);
  border-radius: 0.375rem;
  background: var(--wash);
  font: 600 1rem/1.5 system-ui, sans-serif;
  cursor: pointer;
}

input[type="checkbox"] {
  flex: none;
  width: 1.125rem;
  height: 1.125rem;
  margin: 0.1875rem 0 0;
  accent-color: var(--blue);
}

.actions { display: flex; flex-wrap: wrap; gap: 0.625rem; }

button, .button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  min-height: 2.75rem;
  padding: 0.55rem 1rem;
  border: 1px solid #ad7600;
  border-radius: 0.375rem;
  background: var(--yellow);
  color: var(--ink);
  font: 700 0.9375rem/1.4 var(--mono);
  text-align: center;
  text-decoration: none;
  cursor: pointer;
}

button:hover, .button:hover { background: #ffc94d; }
button.secondary { background: #fff; color: var(--blue); border-color: var(--blue); }
button.secondary:hover { background: var(--wash); }
button.danger { background: var(--danger); color: #fff; border-color: var(--danger); }
button.danger:hover { background: #892217; }

:focus-visible { outline: 3px solid var(--blue); outline-offset: 3px; }
`;

export const hostedStyleSource = `'sha256-${createHash("sha256").update(hostedStyles, "utf8").digest("base64")}'`;
