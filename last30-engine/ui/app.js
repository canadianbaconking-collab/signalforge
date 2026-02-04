const runButton = document.getElementById("runButton");
const copyButton = document.getElementById("copyButton");
const output = document.getElementById("output");
const status = document.getElementById("status");

function setStatus(message) {
  status.textContent = message;
}

async function runQuery() {
  const query = document.getElementById("query").value.trim();
  const target = document.getElementById("target").value;
  const mode = document.getElementById("mode").value;

  if (!query) {
    setStatus("Please enter a query.");
    return;
  }

  setStatus("Running...");
  output.value = "";

  try {
    const response = await fetch("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, target, mode })
    });

    if (!response.ok) {
      const error = await response.json();
      setStatus(`Error: ${error.error || response.statusText}`);
      return;
    }

    const data = await response.json();
    output.value = data.context_block_text || "";
    setStatus(`Run complete: ${data.run_id}`);
  } catch (error) {
    setStatus(`Request failed: ${error.message}`);
  }
}

async function copyContextBlock() {
  if (!output.value) {
    setStatus("No context block to copy.");
    return;
  }

  try {
    await navigator.clipboard.writeText(output.value);
    setStatus("Context block copied to clipboard.");
  } catch (error) {
    setStatus("Clipboard copy failed.");
  }
}

runButton.addEventListener("click", runQuery);
copyButton.addEventListener("click", copyContextBlock);
