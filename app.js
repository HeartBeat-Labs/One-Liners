(() => {
  "use strict";

  // =========================================================
  // Configuration & Storage Keys
  // =========================================================
  const JSON_FILE_PATH = "shuffled_oneliner_sets.json";
  const TOTAL_DAYS = 178;
  const SETS_PER_DAY = 35;
  const STORAGE_KEY = "one_liners_daily_progress_v1";

  // =========================================================
  // Application State
  // =========================================================
  let allSets = []; // Normalized array of { question_id, items: [{ question, answer }] }
  let progressStore = {}; // Map of dayNumber (1..178) -> DayState
  let activeDay = null; // Currently open day number (1..178)
  let activeState = null; // Working state for activeDay (saved only after interaction)
  let pendingModalDay = null; // Day waiting for modal confirmation
  let toastTimeoutId = null; // Tracks active toast timer to prevent overlaps
  let storageWarningShown = false; // Prevents repeated localStorage error toasts

  // =========================================================
  // DOM Elements
  // =========================================================
  const menuView = document.getElementById("menu-view");
  const quizView = document.getElementById("quiz-view");
  const daysGrid = document.getElementById("days-grid");
  const completedDaysCountEl = document.getElementById("completed-days-count");

  const menuBtn = document.getElementById("menu-btn");
  const quizDayTitle = document.getElementById("quiz-day-title");
  const setCounter = document.getElementById("set-counter");
  const revealAllBtn = document.getElementById("reveal-all-btn");
  const progressTrack = document.querySelector(".progress-track");
  const progressFill = document.getElementById("progress-fill");

  const questionIdBadge = document.getElementById("question-id-badge");
  const reviewModeBadge = document.getElementById("review-mode-badge");
  const questionsList = document.getElementById("questions-list");

  const prevBtn = document.getElementById("prev-btn");
  const nextBtn = document.getElementById("next-btn");

  const actionModal = document.getElementById("action-modal");
  const modalTitle = document.getElementById("modal-title");
  const modalMessage = document.getElementById("modal-message");
  const modalPrimaryBtn = document.getElementById("modal-primary-btn");
  const modalRestartBtn = document.getElementById("modal-restart-btn");
  const modalCancelBtn = document.getElementById("modal-cancel-btn");

  const statusToast = document.getElementById("status-toast");

  // =========================================================
  // Utility Functions
  // =========================================================
  function showToast(message, autoHideMs = 0) {
    if (toastTimeoutId !== null) {
      clearTimeout(toastTimeoutId);
      toastTimeoutId = null;
    }

    statusToast.textContent = message;
    statusToast.classList.remove("hidden");

    if (autoHideMs > 0) {
      toastTimeoutId = setTimeout(() => {
        statusToast.classList.add("hidden");
        toastTimeoutId = null;
      }, autoHideMs);
    }
  }

  function hideToast() {
    if (toastTimeoutId !== null) {
      clearTimeout(toastTimeoutId);
      toastTimeoutId = null;
    }
    statusToast.classList.add("hidden");
  }

  /**
   * Produces a derangement of `previousOrder` so that every element
   * moves to a different index (for length >= 2).
   */
  function derangeOrder(previousOrder) {
    const n = previousOrder.length;
    if (n <= 1) return [...previousOrder];

    // Sattolo's algorithm guarantees a single cycle (no fixed points)
    const result = [...previousOrder];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * i); // strictly < i
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  // =========================================================
  // Data Normalization (Handles split lines & '→' parsing)
  // =========================================================
  function normalizeRawSets(rawData) {
    if (!Array.isArray(rawData)) return [];

    const bulletRegex = /^[☛►•▪\-]+\s*/;

    return rawData.map((rawSet, idx) => {
      const mergedLines = [];

      for (const rawLine of rawSet.one_liners || []) {
        const line = String(rawLine).trim();
        if (!line) continue;

        const startsWithBullet = bulletRegex.test(line);

        if (line.startsWith("→") && mergedLines.length > 0) {
          // Answer wrapped onto its own line starting with '→'
          mergedLines[mergedLines.length - 1] += " " + line;
        } else if (
          !startsWithBullet &&
          mergedLines.length > 0 &&
          !mergedLines[mergedLines.length - 1].includes("→") &&
          !line.includes("→")
        ) {
          // Continuation of a multi-line question without a new bullet
          mergedLines[mergedLines.length - 1] += " " + line;
        } else {
          mergedLines.push(line);
        }
      }

      const items = mergedLines.map((entry) => {
        const cleaned = entry.replace(bulletRegex, "").trim();
        const arrowIndex = cleaned.indexOf("→");

        if (arrowIndex !== -1) {
          const question = cleaned.slice(0, arrowIndex).trim();
          const answer = cleaned.slice(arrowIndex + 1).trim();
          return {
            question: question || cleaned,
            answer: answer || "Answer not available",
          };
        }

        // Secondary fallback: split on '?' if an arrow was missing in the PDF
        const qMarkIndex = cleaned.indexOf("?");
        if (qMarkIndex !== -1 && qMarkIndex < cleaned.length - 1) {
          return {
            question: cleaned.slice(0, qMarkIndex + 1).trim(),
            answer: cleaned.slice(qMarkIndex + 1).trim(),
          };
        }

        return {
          question: cleaned,
          answer: "Answer not separated in source text",
        };
      });

      return {
        question_id: rawSet.question_id || `SET_${idx + 1}`,
        items,
      };
    });
  }

  // =========================================================
  // LocalStorage Management
  // =========================================================
  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          progressStore = parsed;
        }
      }
    } catch (err) {
      console.error("Failed to read from localStorage:", err);
      progressStore = {};
    }
  }

  function saveProgress() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(progressStore));
    } catch (err) {
      console.error("Failed to save to localStorage:", err);
      if (!storageWarningShown) {
        storageWarningShown = true;
        showToast(
          "Notice: Browser storage is unavailable. Progress will not persist after reload.",
          4500
        );
      }
    }
  }

  function commitActiveState() {
    if (activeDay !== null && activeState !== null) {
      progressStore[activeDay] = activeState;
      saveProgress();
    }
  }

  function getDaySets(dayNumber) {
    if (dayNumber < 1 || dayNumber > TOTAL_DAYS) return [];
    const startIdx = (dayNumber - 1) * SETS_PER_DAY;
    return allSets.slice(startIdx, startIdx + SETS_PER_DAY);
  }

  /**
   * Creates a fresh DayState.
   * When restarting, guarantees every question moves to a new position within its set.
   */
  function createDayState(dayNumber, isRestart = false, previousState = null) {
    const daySets = getDaySets(dayNumber);
    const setOrders = daySets.map((setObj, setIdx) => {
      const defaultOrder = setObj.items.map((_, i) => i);
      if (!isRestart) return defaultOrder;

      const prevOrder =
        previousState &&
        Array.isArray(previousState.setOrders) &&
        Array.isArray(previousState.setOrders[setIdx]) &&
        previousState.setOrders[setIdx].length === defaultOrder.length
          ? previousState.setOrders[setIdx]
          : defaultOrder;

      return derangeOrder(prevOrder);
    });

    return {
      status: "in-progress", // "in-progress" | "completed"
      currentSetIndex: 0,
      setOrders,
      revealed: {}, // Map of "setIndex:originalItemIdx" -> true
    };
  }

  // =========================================================
  // Main Menu Rendering
  // =========================================================
  function renderMainMenu() {
    daysGrid.innerHTML = "";
    let completedCount = 0;

    const fragment = document.createDocumentFragment();

    for (let day = 1; day <= TOTAL_DAYS; day++) {
      const daySets = getDaySets(day);
      const totalSetsInDay = daySets.length;
      const state = progressStore[day];

      let statusClass = "";
      let statusLabel = totalSetsInDay > 0 ? `${totalSetsInDay} Sets` : "Empty";

      if (state) {
        if (state.status === "completed") {
          completedCount++;
          statusClass = "status-completed";
          statusLabel = "✓ Completed";
        } else if (state.status === "in-progress") {
          statusClass = "status-in-progress";
          const currentPos = Math.min(state.currentSetIndex + 1, totalSetsInDay);
          statusLabel = `Set ${currentPos}/${totalSetsInDay}`;
        }
      }

      const card = document.createElement("div");
      card.className = `day-card ${statusClass}`.trim();
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.setAttribute("aria-label", `Day ${day}, ${statusLabel}`);

      const inner = document.createElement("div");
      inner.className = "day-card-inner";

      const titleEl = document.createElement("div");
      titleEl.className = "day-title";
      titleEl.textContent = `Day ${day}`;

      const statusEl = document.createElement("div");
      statusEl.className = "day-status";
      statusEl.textContent = statusLabel;

      inner.appendChild(titleEl);
      inner.appendChild(statusEl);
      card.appendChild(inner);

      card.addEventListener("click", () => handleDaySelection(day));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleDaySelection(day);
        }
      });

      fragment.appendChild(card);
    }

    daysGrid.appendChild(fragment);
    completedDaysCountEl.textContent = `${completedCount} / ${TOTAL_DAYS} Days Completed`;
  }

  // =========================================================
  // Day Click & Modal Logic (Start / Resume / Review / Restart)
  // =========================================================
  function handleDaySelection(dayNumber) {
    const daySets = getDaySets(dayNumber);
    if (!daySets || daySets.length === 0) {
      showToast(`No sets available for Day ${dayNumber}.`, 3000);
      return;
    }

    const existingState = progressStore[dayNumber];

    // 1. Not started yet -> open immediately (do NOT save to localStorage until user interacts)
    if (!existingState) {
      const freshState = createDayState(dayNumber, false);
      openQuiz(dayNumber, freshState);
      return;
    }

    // 2. Completed -> ask Review or Restart
    if (existingState.status === "completed") {
      pendingModalDay = dayNumber;
      modalTitle.textContent = `Day ${dayNumber} — Completed`;
      modalMessage.textContent =
        "You have completed this quiz. Would you like to review it or restart with shuffled questions?";
      modalPrimaryBtn.textContent = "Review";
      openModal();
      return;
    }

    // 3. In-progress -> ask Resume or Restart
    pendingModalDay = dayNumber;
    const savedSet = Math.min(existingState.currentSetIndex + 1, daySets.length);
    modalTitle.textContent = `Day ${dayNumber} — In Progress`;
    modalMessage.textContent = `You stopped at Set ${savedSet} of ${daySets.length}. Would you like to resume or restart?`;
    modalPrimaryBtn.textContent = "Resume";
    openModal();
  }

  function openModal() {
    actionModal.classList.remove("hidden");
    modalPrimaryBtn.focus();
  }

  function closeModal() {
    actionModal.classList.add("hidden");
    pendingModalDay = null;
  }

  // Resume or Review button inside dialog
  modalPrimaryBtn.addEventListener("click", () => {
    if (pendingModalDay === null) return;
    const day = pendingModalDay;
    const state = progressStore[day];

    if (state && state.status === "completed") {
      state.currentSetIndex = 0;
      saveProgress();
    }

    closeModal();
    openQuiz(day, state);
  });

  // Restart button inside dialog -> shuffles every question to a new position within its set
  modalRestartBtn.addEventListener("click", () => {
    if (pendingModalDay === null) return;
    const day = pendingModalDay;
    const previousState = progressStore[day] || null;
    const restartedState = createDayState(day, true, previousState);

    progressStore[day] = restartedState;
    saveProgress();

    closeModal();
    openQuiz(day, restartedState);
    showToast(`Day ${day} restarted & questions shuffled!`, 2500);
  });

  modalCancelBtn.addEventListener("click", closeModal);

  actionModal.addEventListener("click", (e) => {
    if (e.target === actionModal) {
      closeModal();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !actionModal.classList.contains("hidden")) {
      closeModal();
    }
  });

  // =========================================================
  // Quiz View & Rendering
  // =========================================================
  function openQuiz(dayNumber, stateObj) {
    activeDay = dayNumber;
    activeState = stateObj;
    menuView.classList.add("hidden");
    quizView.classList.remove("hidden");
    window.scrollTo(0, 0);
    renderCurrentSet();
  }

  function returnToMenu() {
    activeDay = null;
    activeState = null;
    quizView.classList.add("hidden");
    menuView.classList.remove("hidden");
    renderMainMenu();
    window.scrollTo(0, 0);
  }

  function renderCurrentSet() {
    const daySets = getDaySets(activeDay);
    if (!daySets.length || !activeState) {
      returnToMenu();
      return;
    }

    const totalSets = daySets.length;

    // Clamp index safely
    if (activeState.currentSetIndex < 0) activeState.currentSetIndex = 0;
    if (activeState.currentSetIndex >= totalSets) {
      activeState.currentSetIndex = totalSets - 1;
    }

    const setIdx = activeState.currentSetIndex;
    const currentSet = daySets[setIdx];
    const isCompletedDay = activeState.status === "completed";

    // Header & Progress Bar
    quizDayTitle.textContent = `Day ${activeDay}`;
    setCounter.textContent = `Set ${setIdx + 1} of ${totalSets}`;
    questionIdBadge.textContent = `ID: ${currentSet.question_id}`;

    if (isCompletedDay) {
      reviewModeBadge.classList.remove("hidden");
    } else {
      reviewModeBadge.classList.add("hidden");
    }

    const progressPercent = ((setIdx + 1) / totalSets) * 100;
    progressFill.style.width = `${progressPercent}%`;
    progressTrack.setAttribute("aria-valuemax", String(totalSets));
    progressTrack.setAttribute("aria-valuenow", String(setIdx + 1));

    // Ensure valid order mapping exists for this set
    const order =
      Array.isArray(activeState.setOrders) &&
      Array.isArray(activeState.setOrders[setIdx]) &&
      activeState.setOrders[setIdx].length === currentSet.items.length
        ? activeState.setOrders[setIdx]
        : currentSet.items.map((_, i) => i);

    // Render questions inside the set
    questionsList.innerHTML = "";
    let allRevealedInSet = currentSet.items.length > 0;

    order.forEach((originalItemIdx, displayPosition) => {
      const qa = currentSet.items[originalItemIdx];
      if (!qa) return;

      const revealKey = `${setIdx}:${originalItemIdx}`;
      const isRevealed = Boolean(activeState.revealed[revealKey]);
      if (!isRevealed) allRevealedInSet = false;

      const itemCard = document.createElement("div");
      itemCard.className = "question-item";

      const qText = document.createElement("div");
      qText.className = "question-text";

      const qNum = document.createElement("span");
      qNum.className = "question-number";
      qNum.textContent = `Q${displayPosition + 1}.`;

      qText.appendChild(qNum);
      qText.appendChild(document.createTextNode(qa.question));

      const revealBtn = document.createElement("button");
      revealBtn.type = "button";
      revealBtn.className = `reveal-btn ${isRevealed ? "revealed" : ""}`.trim();
      revealBtn.textContent = isRevealed ? "Hide Answer" : "Reveal Answer";

      const answerBox = document.createElement("div");
      answerBox.className = `answer-box ${isRevealed ? "" : "hidden"}`.trim();
      answerBox.textContent = `→ ${qa.answer}`;

      revealBtn.addEventListener("click", () => {
        const currentlyVisible = !answerBox.classList.contains("hidden");
        if (currentlyVisible) {
          answerBox.classList.add("hidden");
          revealBtn.textContent = "Reveal Answer";
          revealBtn.classList.remove("revealed");
          delete activeState.revealed[revealKey];
        } else {
          answerBox.classList.remove("hidden");
          revealBtn.textContent = "Hide Answer";
          revealBtn.classList.add("revealed");
          activeState.revealed[revealKey] = true;
        }
        commitActiveState();
        updateRevealAllButtonState();
      });

      itemCard.appendChild(qText);
      itemCard.appendChild(revealBtn);
      itemCard.appendChild(answerBox);
      questionsList.appendChild(itemCard);
    });

    revealAllBtn.textContent = allRevealedInSet ? "Hide All" : "Reveal All";

    // Bottom Navigation Buttons
    prevBtn.disabled = setIdx === 0;

    const isLastSet = setIdx === totalSets - 1;
    const hasNextDayQuiz =
      activeDay < TOTAL_DAYS && getDaySets(activeDay + 1).length > 0;

    if (isLastSet) {
      nextBtn.textContent = hasNextDayQuiz ? "Next Quiz →" : "Finish Quiz ✓";
      nextBtn.classList.remove("btn-primary");
      nextBtn.classList.add("btn-complete");
    } else {
      nextBtn.textContent = "Next →";
      nextBtn.classList.remove("btn-complete");
      nextBtn.classList.add("btn-primary");
    }
  }

  function updateRevealAllButtonState() {
    if (activeDay === null || !activeState) return;
    const daySets = getDaySets(activeDay);
    const setIdx = activeState.currentSetIndex;
    const currentSet = daySets[setIdx];
    if (!currentSet) return;

    const allRevealed =
      currentSet.items.length > 0 &&
      currentSet.items.every((_, idx) =>
        Boolean(activeState.revealed[`${setIdx}:${idx}`])
      );
    revealAllBtn.textContent = allRevealed ? "Hide All" : "Reveal All";
  }

  // =========================================================
  // Quiz Navigation & Action Event Listeners
  // =========================================================
  menuBtn.addEventListener("click", returnToMenu);

  revealAllBtn.addEventListener("click", () => {
    if (activeDay === null || !activeState) return;
    const daySets = getDaySets(activeDay);
    const setIdx = activeState.currentSetIndex;
    const currentSet = daySets[setIdx];
    if (!currentSet) return;

    const allCurrentlyRevealed = currentSet.items.every((_, idx) =>
      Boolean(activeState.revealed[`${setIdx}:${idx}`])
    );

    currentSet.items.forEach((_, idx) => {
      const key = `${setIdx}:${idx}`;
      if (allCurrentlyRevealed) {
        delete activeState.revealed[key];
      } else {
        activeState.revealed[key] = true;
      }
    });

    commitActiveState();
    renderCurrentSet();
  });

  prevBtn.addEventListener("click", () => {
    if (activeDay === null || !activeState) return;
    if (activeState.currentSetIndex > 0) {
      activeState.currentSetIndex--;
      commitActiveState();
      renderCurrentSet();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  nextBtn.addEventListener("click", () => {
    if (activeDay === null || !activeState) return;
    const daySets = getDaySets(activeDay);
    const isLastSet = activeState.currentSetIndex >= daySets.length - 1;

    if (!isLastSet) {
      activeState.currentSetIndex++;
      commitActiveState();
      renderCurrentSet();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      // Mark current day quiz as completed
      activeState.status = "completed";
      commitActiveState();

      const nextDay = activeDay + 1;
      const hasNextDayQuiz =
        activeDay < TOTAL_DAYS && getDaySets(nextDay).length > 0;

      if (hasNextDayQuiz) {
        showToast(`Day ${activeDay} Completed!`, 2500);
        // Route through handleDaySelection so Resume / Review / Restart dialog is respected
        handleDaySelection(nextDay);
      } else {
        showToast("Congratulations! You have completed all available quizzes!", 4000);
        returnToMenu();
      }
    }
  });

  // =========================================================
  // Initialization
  // =========================================================
  async function init() {
    showToast("Loading One Liners...");
    loadProgress();

    try {
      const response = await fetch(JSON_FILE_PATH);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while loading ${JSON_FILE_PATH}`);
      }
      const rawJson = await response.json();
      allSets = normalizeRawSets(rawJson);

      hideToast();
      renderMainMenu();
    } catch (error) {
      console.error("Initialization error:", error);
      showToast(
        "Error loading shuffled_oneliner_sets.json. Please run via a local server (e.g., Live Server or python -m http.server)."
      );
    }
  }

  init();
})();