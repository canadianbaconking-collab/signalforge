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
let reviewData = null;
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
  const marker = "TOP SIGNALS (triage order)";
  const start = contextBlockText.indexOf(marker);
  if (start === -1) {
    return "";
  }

  const fromTopClaims = contextBlockText.slice(start + marker.length);
  const nextSections = ["\nEVIDENCE ADJUDICATION", "\nPROMPT PACK", "\nNEW SIGNALS"];
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
    .filter((line) => /^\d+\./.test(line))
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
  reviewData = null;
  document.getElementById("reviewPanel").hidden = true;
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
    await loadReview(data.run_id);
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


async function loadReview(runId) {
  const response = await fetch(`/review/${encodeURIComponent(runId)}`);
  if (!response.ok) throw new Error("Could not load claim review");
  reviewData = await response.json();
  const panel = document.getElementById("reviewPanel");
  panel.hidden = false;
  const claimSelect = document.getElementById("reviewClaim");
  claimSelect.replaceChildren();
  const keys = document.getElementById("reviewClaimKeys");
  keys.replaceChildren();
  const rankByClaim = new Map(reviewData.ranked_claims.map((claim) => [claim.claim_id, claim]));
  const rankedCandidates = [...reviewData.candidates].sort((a, b) =>
    (rankByClaim.get(b.claim_id)?.score ?? 0) - (rankByClaim.get(a.claim_id)?.score ?? 0) ||
    a.claim_id.localeCompare(b.claim_id));
  for (const claim of rankedCandidates) {
    const option = document.createElement("option");
    option.value = claim.claim_id;
    option.textContent = `${claim.label} — ${claim.status}, triage ${rankByClaim.get(claim.claim_id)?.score ?? "?"} (${claim.observations.length})`;
    claimSelect.append(option);
    const suggestion = document.createElement("option");
    suggestion.value = reviewData.snapshot.accepted.find(item => item.claim_id === claim.claim_id)?.claim_key || claim.label;
    keys.append(suggestion);
  }
  document.getElementById("reviewArtifact").textContent =
    `Artifact: ${reviewData.snapshot.artifact_id} · ${reviewData.snapshot.rejected.length} rejected observations preserved`;
  const history = document.getElementById("reviewHistory");
  history.textContent = `${reviewData.history.length} recorded review event(s). Latest rationale: ${reviewData.history.at(-1)?.rationale || "none"}`;
  renderReviewObservations();
}

function selectedObservation() {
  return reviewData?.snapshot.accepted.find(item => item.url === document.getElementById("reviewObservation").value);
}

function renderReviewObservations() {
  const claim = reviewData?.candidates.find(item => item.claim_id === document.getElementById("reviewClaim").value);
  const select = document.getElementById("reviewObservation");
  select.replaceChildren();
  for (const observation of claim?.observations || []) {
    const option = document.createElement("option");
    option.value = observation.url;
    option.textContent = `${observation.source}: ${observation.title}`;
    select.append(option);
  }
  renderReviewDetail();
}

function renderReviewDetail() {
  const item = selectedObservation();
  const detail = document.getElementById("reviewDetail");
  detail.replaceChildren();
  if (!item) {
    detail.textContent = "No accepted observations in this run.";
    return;
  }
  const link = document.createElement("a");
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = item.url;
  detail.append(link);
  const summary = document.createElement("p");
  summary.textContent = `${item.source} · ${item.published_at} · ${item.timestamp_tier} · ${item.family_basis} family · ${item.metadata_origin} metadata`;
  detail.append(summary);
  document.getElementById("reviewClaimKey").value = item.claim_key;
  document.getElementById("reviewStance").value = item.stance;
  document.getElementById("reviewPrimaryUrl").value = item.primary_url || "";
  document.getElementById("reviewOriginatorId").value = item.originator_id || "";
  document.getElementById("reviewIncentives").value = item.incentives || "";
  document.getElementById("reviewChannels").value = (item.channels || []).join(", ");
  document.getElementById("reviewStatus").textContent = "";
}

async function saveReview() {
  const item = selectedObservation();
  const status = document.getElementById("reviewStatus");
  if (!item) return;
  const rationale = document.getElementById("reviewRationale").value.trim();
  const edits = { url: item.url };
  const textFields = [
    ["claim_key", "reviewClaimKey"], ["primary_url", "reviewPrimaryUrl"],
    ["originator_id", "reviewOriginatorId"], ["incentives", "reviewIncentives"]
  ];
  for (const [field, id] of textFields) {
    const next = document.getElementById(id).value.trim();
    const current = item[field] || "";
    if (next !== current) edits[field] = next || null;
  }
  const stance = document.getElementById("reviewStance").value;
  if (stance !== item.stance) edits.stance = stance;
  const channels = [...new Set(document.getElementById("reviewChannels").value.split(",").map(x => x.trim()).filter(Boolean))].sort();
  if (JSON.stringify(channels) !== JSON.stringify(item.channels || [])) edits.channels = channels;
  if (!rationale || Object.keys(edits).length === 1) {
    status.textContent = "Add a rationale and change at least one field.";
    return;
  }
  status.textContent = "Recording review…";
  try {
    const response = await fetch(`/review/${encodeURIComponent(reviewData.run_id)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_artifact_id: reviewData.latest_artifact_id, rationale, edits: [edits] })
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Review failed");
    }
    await loadReview(reviewData.run_id);
    document.getElementById("reviewRationale").value = "";
    status.textContent = "Review saved. Decision records can cite the new artifact ID.";
  } catch (error) {
    status.textContent = `Review failed: ${error.message}`;
  }
}

runButton.addEventListener("click", runQuery);
document.getElementById("reviewClaim").addEventListener("change", renderReviewObservations);
document.getElementById("reviewObservation").addEventListener("change", renderReviewDetail);
document.getElementById("saveReviewButton").addEventListener("click", saveReview);
copyButton.addEventListener("click", copyContextBlock);
copySummaryButton.addEventListener("click", copySummary);
copyPromptPackButton.addEventListener("click", copyPromptPack);
presetSelect.addEventListener("change", applyPreset);
