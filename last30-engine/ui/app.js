const runButton = document.getElementById("runButton");
const copyButton = document.getElementById("copyButton");
const copySummaryButton = document.getElementById("copySummaryButton");
const copyPromptPackButton = document.getElementById("copyPromptPackButton");
const presetSelect = document.getElementById("preset");
const output = document.getElementById("output");
const claimsPreview = document.getElementById("claimsPreview");
const status = document.getElementById("status");
const toast = document.getElementById("toast");

let lastRunData = null;
let toastTimeout = null;

const PRESETS = {
  daily: {
    window_days: 7,
    mode: "quick",
    sources: ["reddit", "hn", "github_issue", "github_release"]
  },
  deep: {
    window_days: 30,
    mode: "deep",
    sources: ["reddit", "hn", "github_issue", "github_release"]
  },
  debug: {
    window_days: 7,
    mode: "quick",
    sources: ["reddit"]
  }
};

function setStatus(message) {
  status.textContent = message;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }
  toastTimeout = setTimeout(() => {
    toast.classList.remove("show");
  }, 1200);
}

function shortRunId(runId) {
  if (!runId) {
    return "—";
  }
  if (runId.length <= 14) {
    return runId;
  }
  return `${runId.slice(0, 8)}…${runId.slice(-4)}`;
}

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSources(value) {
  return value
    .split(",")
    .map((source) => source.trim())
    .filter(Boolean);
}

function updateStatusPanel(data) {
  const runIdEl = document.getElementById("runIdShort");
  const integrityEl = document.getElementById("integrityScore");
  const noveltyEl = document.getElementById("noveltyTelemetry");
  const baselineEl = document.getElementById("baselineTelemetry");
  const flagsEl = document.getElementById("flags");
  const degradedWarningEl = document.getElementById("degradedWarning");

  runIdEl.textContent = shortRunId(data?.run_id);
  integrityEl.textContent = data?.integrity_score ?? "—";

  const novelty = data?.run_telemetry?.novelty;
  noveltyEl.textContent = novelty
    ? `${novelty.achieved_ratio ?? "?"} ratio, ${novelty.novel_clusters_in_top ?? "?"} clusters`
    : "—";

  const baseline = data?.run_telemetry?.baseline;
  baselineEl.textContent = baseline ? `${baseline.clusters_with_baseline ?? "?"} clusters` : "—";

  flagsEl.innerHTML = "";
  const flags = Array.isArray(data?.flags) ? data.flags : [];
  if (!flags.length) {
    const none = document.createElement("span");
    none.className = "pill";
    none.textContent = "none";
    flagsEl.appendChild(none);
  } else {
    flags.forEach((flag) => {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = flag;
      flagsEl.appendChild(pill);
    });
  }

  const degradedFlags = flags.filter((flag) => flag.startsWith("DEGRADED_SIGNAL_"));
  if (degradedFlags.length > 0) {
    degradedWarningEl.style.display = "block";
    degradedWarningEl.textContent = `Warning: degraded signal detected (${degradedFlags.join(", ")}).`;
  } else {
    degradedWarningEl.style.display = "none";
    degradedWarningEl.textContent = "";
  }
}


function toArtifactRelativePath(artifactPath) {
  if (!artifactPath) {
    return "";
  }
  const marker = `${"/"}runs${"/"}`;
  const idx = artifactPath.lastIndexOf(marker);
  if (idx === -1) {
    return artifactPath.replace(/^\/+/, "");
  }
  return artifactPath.slice(idx + marker.length);
}

function extractPromptPack(contextBlockText) {
  if (!contextBlockText) {
    return "";
  }
  const promptStart = contextBlockText.indexOf("PROMPT PACK");
  if (promptStart === -1) {
    return "";
  }

  const fromPrompt = contextBlockText.slice(promptStart);
  const sections = ["\\nTOP CLAIMS", "\\nNEW SIGNALS", "\\nNOTES", "\\nMETADATA"];
  let endIndex = fromPrompt.length;
  for (const marker of sections) {
    const idx = fromPrompt.indexOf(marker, 1);
    if (idx !== -1 && idx < endIndex) {
      endIndex = idx;
    }
  }
  return fromPrompt.slice(0, endIndex).trim();
}

function extractTopClaims(contextBlockText) {
  if (!contextBlockText) {
    return "";
  }
  const start = contextBlockText.indexOf("TOP CLAIMS");
  if (start === -1) {
    return "";
  }

  const fromTopClaims = contextBlockText.slice(start + "TOP CLAIMS".length);
  const nextSections = ["\\nPROMPT PACK", "\\nNEW SIGNALS", "\\nNOTES", "\\nMETADATA"];
  let endIndex = fromTopClaims.length;
  for (const marker of nextSections) {
    const idx = fromTopClaims.indexOf(marker);
    if (idx !== -1 && idx < endIndex) {
      endIndex = idx;
    }
  }

  return fromTopClaims
    .slice(0, endIndex)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .join("\n");
}

async function copyText(text, successMessage, emptyMessage) {
  if (!text) {
    setStatus(emptyMessage);
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setStatus(successMessage);
    showToast("Copied!");
  } catch (error) {
    setStatus("Clipboard copy failed.");
  }
}

async function runQuery() {
  const query = document.getElementById("query").value.trim();
  const target = document.getElementById("target").value;
  const mode = document.getElementById("mode").value;
  const windowDays = toNumberOrNull(document.getElementById("windowDays").value);
  const sources = parseSources(document.getElementById("sources").value);

  if (!query) {
    setStatus("Please enter a query.");
    return;
  }

  setStatus("Running...");
  output.value = "";
  claimsPreview.value = "";
  updateStatusPanel(null);

  try {
    const response = await fetch("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, target, mode, window_days: windowDays, sources })
    });

    if (!response.ok) {
      let errorText = response.statusText;
      try {
        const error = await response.json();
        errorText = error.error || errorText;
      } catch (_error) {
        errorText = await response.text();
      }
      setStatus(`Run failed: ${errorText}`);
      return;
    }

    const data = await response.json();
    lastRunData = data;
    output.value = data.context_block_text || "";
    claimsPreview.value = extractTopClaims(output.value);
    updateStatusPanel(data);
    setStatus(`Run complete: ${data.run_id}`);
  } catch (error) {
    setStatus(`Run failed: ${error.message}`);
  }
}

async function copyContextBlock() {
  await copyText(output.value, "Context block copied to clipboard.", "No context block to copy.");
}

async function copyPromptPack() {
  const promptPack = extractPromptPack(output.value);
  await copyText(promptPack, "Prompt pack copied to clipboard.", "No prompt pack found in context block.");
}

async function copySummary() {
  if (!lastRunData) {
    setStatus("Run a query before copying summary.");
    return;
  }

  const summaryPath = lastRunData.artifacts?.summary;
  if (!summaryPath) {
    setStatus("No summary artifact path available.");
    return;
  }

  try {
    const relativeSummaryPath = toArtifactRelativePath(summaryPath);
    const response = await fetch(`/artifact?path=${encodeURIComponent(relativeSummaryPath)}`);
    if (!response.ok) {
      setStatus("Summary artifact unavailable.");
      return;
    }

    const summaryText = await response.text();
    await copyText(summaryText, "Summary copied to clipboard.", "Summary was empty.");
  } catch (error) {
    setStatus(`Failed to fetch summary: ${error.message}`);
  }
}

function applyPreset() {
  const preset = PRESETS[presetSelect.value];
  if (!preset) {
    return;
  }

  document.getElementById("windowDays").value = String(preset.window_days);
  document.getElementById("mode").value = preset.mode;
  document.getElementById("sources").value = preset.sources.join(",");
  setStatus(`Preset applied: ${presetSelect.options[presetSelect.selectedIndex].text}`);
}

runButton.addEventListener("click", runQuery);
copyButton.addEventListener("click", copyContextBlock);
copySummaryButton.addEventListener("click", copySummary);
copyPromptPackButton.addEventListener("click", copyPromptPack);
presetSelect.addEventListener("change", applyPreset);
