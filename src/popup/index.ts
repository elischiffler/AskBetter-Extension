// ---------------------------------------------------------------------------
// Popup script — two-tab dashboard: Tips and Settings.
// Settings are persisted via chrome.storage.sync and broadcast to content
// scripts via a SETTINGS_UPDATE message.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Settings {
  pillsEnabled: boolean;
  badgeEnabled: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  pillsEnabled: true,
  badgeEnabled: true,
};

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

async function loadSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get('askbetter_settings', (result) => {
      const saved = result['askbetter_settings'] as Partial<Settings> | undefined;
      resolve({ ...DEFAULT_SETTINGS, ...saved });
    });
  });
}

function saveSettings(settings: Settings): void {
  chrome.storage.sync.set({ askbetter_settings: settings });
  // Broadcast to all content scripts so changes take effect immediately
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATE', settings }).catch(() => {
          /* tab may not have content script */
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function initTabs(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
  const panels = document.querySelectorAll<HTMLElement>('.tab-panel');

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset['tab'];
      buttons.forEach((b) => b.classList.toggle('active', b === btn));
      panels.forEach((p) => {
        const id = p.id.replace('tab-', '');
        p.classList.toggle('active', id === target);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

function initSettingsTab(settings: Settings): void {
  const pillsEl = document.getElementById('setting-pills') as HTMLInputElement | null;
  const badgeEl = document.getElementById('setting-badge') as HTMLInputElement | null;
  const resetBtn = document.getElementById('reset-btn');
  const toast = document.getElementById('saved-toast');

  if (!pillsEl || !badgeEl) return;

  // Populate from loaded settings
  pillsEl.checked = settings.pillsEnabled;
  badgeEl.checked = settings.badgeEnabled;

  function showToast(): void {
    if (!toast) return;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1800);
  }

  function currentSettings(): Settings {
    return {
      pillsEnabled: pillsEl!.checked,
      badgeEnabled: badgeEl!.checked,
    };
  }

  function persist(): void {
    saveSettings(currentSettings());
    showToast();
  }

  pillsEl.addEventListener('change', persist);
  badgeEl.addEventListener('change', persist);

  resetBtn?.addEventListener('click', () => {
    pillsEl.checked = DEFAULT_SETTINGS.pillsEnabled;
    badgeEl.checked = DEFAULT_SETTINGS.badgeEnabled;
    saveSettings(DEFAULT_SETTINGS);
    showToast();
  });
}

// ---------------------------------------------------------------------------
// Platform badge in header
// ---------------------------------------------------------------------------

function setPlatformBadge(): void {
  const badge = document.getElementById('platform-badge');
  if (!badge) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0]?.url ?? '';
    if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) {
      badge.textContent = 'ChatGPT';
    } else if (url.includes('gemini.google.com')) {
      badge.textContent = 'Gemini';
    } else if (url.includes('perplexity.ai')) {
      badge.textContent = 'Perplexity';
    } else {
      badge.textContent = 'Inactive';
      badge.style.color = '#6b5fa0';
      badge.style.borderColor = 'rgba(107, 95, 160, 0.3)';
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  initTabs();
  setPlatformBadge();

  const settings = await loadSettings();
  initSettingsTab(settings);
}

boot();
