interface AntiRecallConfig {
  mainColor: string;
  saveDb: boolean;
  saveImagesToDataDir: boolean;
  enableShadow: boolean;
  enableTip: boolean;
  isAntiRecallSelfMsg: boolean;
  enablePeriodicCleanup: boolean;
  maxMsgSaveLimit: number;
  deleteMsgCountPerTime: number;
  enableNapcatRkey: boolean;
  napcatRkeyUrl: string;
  napcatRkeyToken: string;
}

const packageJson = {
  name: "qwqnt-better-anti-recall",
  qwqnt: {
    name: "防撤回（Anti-Recall）",
  },
} satisfies IQwQNTPlugin;

const DEFAULT_CONFIG: AntiRecallConfig = {
  mainColor: "#ff6d6d",
  saveDb: false,
  saveImagesToDataDir: false,
  enableShadow: true,
  enableTip: true,
  isAntiRecallSelfMsg: false,
  enablePeriodicCleanup: true,
  maxMsgSaveLimit: 10_000,
  deleteMsgCountPerTime: 500,
  enableNapcatRkey: false,
  napcatRkeyUrl: "",
  napcatRkeyToken: "",
};

let recalledIds: string[] = [];
let currentConfig: AntiRecallConfig = { ...DEFAULT_CONFIG };

function waitForHakoGlobals(): void {
  const hasRendererEvents =
    typeof (globalThis as any).RendererEvents !== "undefined";
  const hasPluginSettings =
    typeof (globalThis as any).PluginSettings !== "undefined";

  if (!hasRendererEvents || !hasPluginSettings) {
    setTimeout(waitForHakoGlobals, 100);
    return;
  }

  RendererEvents.onSettingsWindowCreated(() => {
    void registerSettingsPage();
  });
}

waitForHakoGlobals();
void setupMainWindowPatches();

async function getNowConfig(): Promise<AntiRecallConfig> {
  try {
    const cfg = await window.anti_recall?.getNowConfig<AntiRecallConfig>();
    return cfg ?? { ...DEFAULT_CONFIG };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function registerSettingsPage(): Promise<void> {
  try {
    const view =
      await PluginSettings.renderer.registerPluginSettings(packageJson);
    await renderSettings(view);
  } catch (e) {
    console.error("[Anti-Recall] 注册设置页失败:", e);
  }
}

function setSwitchActive(el: HTMLElement, active: boolean): void {
  el.classList.toggle("is-active", active);
}

async function renderSettings(container: HTMLDivElement): Promise<void> {
  currentConfig = await getNowConfig();

  const html = `
    <plugin-menu>
      <setting-item class="config_view">
        <setting-section data-title="主配置">
          <setting-panel>
            <setting-list data-direction="column">
              <setting-item data-direction="row">
                <setting-text>操作</setting-text>
                <div style="display:flex;gap:10px;">
                  <button id="viewRecalled" class="q-button q-button--small q-button--secondary">查看所有已撤回的消息</button>
                  <button id="clearDb" class="q-button q-button--small q-button--secondary">清空已储存的撤回消息</button>
                </div>
              </setting-item>

              <setting-item data-direction="row">
                <div style="width:90%;">
                  <setting-text>是否将撤回消息存入数据库</setting-text>
                  <span class="secondary-text">数据库永久增量保存；若不开启，重启 QQ 后撤回消息会丢失。</span>
                </div>
                <div id="switchSaveDb" class="q-switch">
                  <span class="q-switch__handle"></span>
                </div>
              </setting-item>

              <setting-item id="storageStatusRow" data-direction="row" class="hidden">
                <div style="width:100%;">
                  <setting-text>存储状态</setting-text>
                  <span class="secondary-text">明文 JSON，按 1 MB 自动分片存放在数据目录的 recalled 子文件夹。</span>
                  <div id="storageStatus" class="secondary-text" style="margin-top:6px;color:var(--text_tertiary);"></div>
                </div>
              </setting-item>

              <setting-item data-direction="row">
                <div style="width:90%;">
                  <setting-text>是否将撤回图片保存到数据目录</setting-text>
                  <span class="secondary-text">开启后，撤回消息中的图片会额外复制到数据目录的 images 子文件夹。</span>
                </div>
                <div id="switchSaveImages" class="q-switch">
                  <span class="q-switch__handle"></span>
                </div>
              </setting-item>

              <div class="vertical-list-item">
                <div style="width:90%;">
                  <h2>是否反撤回自己的消息</h2>
                  <span class="secondary-text">如果开启，则自己发送的消息也会被反撤回。开启后，从下一条消息开始起生效。</span>
                </div>
                <div id="switchAntiRecallSelf" class="q-switch">
                  <span class="q-switch__handle"></span>
                </div>
              </div>

              <div class="vertical-list-item">
                <div style="width:90%;">
                  <h2>启用定期清理</h2>
                  <span class="secondary-text">关闭后，内存中的消息缓存将永久保留（不自动清理），可能导致内存占用持续增长；开启时，可配置下方两项。</span>
                </div>
                <div id="switchPeriodicCleanup" class="q-switch">
                  <span class="q-switch__handle"></span>
                </div>
              </div>

              <div id="periodicCleanupSub" class="periodic-cleanup-sub">
                <setting-item data-direction="row">
                  <div>
                    <h2>内存中消息最多缓存条数</h2>
                    <span class="secondary-text">修改将自动保存并立即生效；如果过少可能导致消息接受太快时来不及反撤回，如果过多可能导致内存占用过高。</span>
                  </div>
                  <div style="width:30%;pointer-events: auto;margin-left:10px;">
                    <input id="maxMsgLimit" min="1" max="99999999" maxlength="8" class="text_color path-input" style="width:65%;" type="number" value="${currentConfig.maxMsgSaveLimit ?? 10_000}"/>条
                  </div>
                </setting-item>

                <setting-item data-direction="row">
                  <div>
                    <h2>清理内存缓存消息时一次性清理多少</h2>
                    <span class="secondary-text">修改将自动保存并立即生效；一次性清理过多可能导致某些消息反撤回失败，过少则可能导致内存增长过快。</span>
                  </div>
                  <div style="width:30%;pointer-events: auto;margin-left:10px;">
                    <input id="deletePerTime" min="1" max="99999" maxlength="5" class="text_color path-input" style="width:65%; margin-left: 3px" type="number" value="${currentConfig.deleteMsgCountPerTime ?? 500}"/>条
                  </div>
                </setting-item>
              </div>
            </setting-list>
          </setting-panel>
        </setting-section>

        <setting-section data-title="RKey 获取">
          <setting-panel>
            <setting-list data-direction="column">
              <setting-item data-direction="row">
                <div style="width:90%;">
                  <setting-text>从 NapCat 获取 RKey</setting-text>
                  <span class="secondary-text">开启后优先从 NapCat WebUI 的 nc_get_rkey 接口获取 RKey；失败时回退到外部服务器和网络抓取。</span>
                </div>
                <div id="switchNapcatRkey" class="q-switch">
                  <span class="q-switch__handle"></span>
                </div>
              </setting-item>

              <setting-item id="napcatRkeyCfg" data-direction="column" class="hidden">
                <div class="anti-recall-rkey">
                  <div class="anti-recall-rkey__field">
                    <label for="napcatRkeyUrl">NapCat WebUI 地址</label>
                    <span class="anti-recall-rkey__field-hint">NapCat WebUI 访问地址，如 http://127.0.0.1:6099</span>
                    <input id="napcatRkeyUrl" class="anti-recall-rkey__input" type="text" placeholder="http://127.0.0.1:6099" value="${currentConfig.napcatRkeyUrl ?? ""}"/>
                  </div>
                  <div class="anti-recall-rkey__field">
                    <label for="napcatRkeyToken">WebUI Token</label>
                    <span class="anti-recall-rkey__field-hint">NapCat WebUI 的登录 token（设置-网络配置 中的 WebUI token）</span>
                    <input id="napcatRkeyToken" class="anti-recall-rkey__input" type="password" value="${currentConfig.napcatRkeyToken ?? ""}"/>
                  </div>
                  <div class="anti-recall-rkey__actions">
                    <button id="testNapcatRkey" class="anti-recall-rkey__button" type="button">测试连接</button>
                    <span id="napcatRkeyTestResult" class="anti-recall-rkey__result" hidden></span>
                  </div>
                </div>
              </setting-item>
            </setting-list>
          </setting-panel>
        </setting-section>

        <setting-section data-title="样式配置">
          <setting-panel>
            <setting-list data-direction="column">
              <setting-item data-direction="row">
                <div>
                  <h2>撤回主题色</h2>
                  <span class="secondary-text">将会同时影响阴影和“已撤回”提示的颜色</span>
                </div>
                <div>
                  <input type="color" value="${currentConfig.mainColor}" class="q-button q-button--small q-button--secondary pick-color" />
                </div>
              </setting-item>

              <hr class="horizontal-dividing-line" />

              <div class="vertical-list-item">
                <div>
                  <h2>撤回后消息是否显示阴影</h2>
                  <span class="secondary-text">修改将自动保存并实时生效</span>
                </div>
                <div id="switchShadow" class="q-switch">
                  <span class="q-switch__handle"></span>
                </div>
              </div>

              <hr class="horizontal-dividing-line" />

              <div class="vertical-list-item">
                <div>
                  <h2>撤回后消息下方是否显示“已撤回”提示</h2>
                  <span class="secondary-text">修改将自动保存并在重新滚动消息后生效</span>
                </div>
                <div id="switchTip" class="q-switch">
                  <span class="q-switch__handle"></span>
                </div>
              </div>
            </setting-list>
          </setting-panel>
        </setting-section>

        <style>
          .path-input { align-self: normal; flex: 1; border-radius: 4px; margin-right: 16px; transition: all 100ms ease-out; border: 1px solid #464646; }
          .path-input:focus { padding-left: 4px; }
          .config_view { margin: 20px; }
          .config_view .vertical-list-item { margin: 12px 0px; display: flex; justify-content: space-between; align-items: center; }
          .config_view .horizontal-dividing-line { border: unset; margin: unset; height: 1px; background-color: rgba(127, 127, 127, 0.15); }
          .config_view .hidden { display: none !important; }
          .anti-recall-empty { color: var(--text_secondary); line-height: 28px; padding-top: 40px; text-align: center; }
          .config_view .periodic-cleanup-sub.hidden { display: none !important; }
          .config_view .secondary-text { color: var(--text_secondary); font-size: min(var(--font_size_2), 16px); line-height: min(var(--line_height_2), 22px); margin-top: 4px; }
          .anti-recall-rkey * { box-sizing: border-box; }
          .anti-recall-rkey__field { margin-top: 14px; }
          .anti-recall-rkey__field:first-child { margin-top: 0; }
          .anti-recall-rkey__field > label {
            display: block;
            font-size: 13px;
            font-weight: 500;
            line-height: 20px;
            margin-bottom: 2px;
          }
          .anti-recall-rkey__field-hint {
            color: var(--text_secondary, #72777f);
            display: block;
            font-size: 12px;
            line-height: 18px;
            margin-bottom: 7px;
            overflow-wrap: anywhere;
          }
          .anti-recall-rkey__input {
            background: var(--fill_light_primary, var(--bg_bottom_standard, #fff));
            border: 1px solid var(--fill_standard_primary, rgba(127, 127, 127, .22));
            border-radius: 6px;
            color: var(--text_primary, #202124);
            font: inherit;
            height: 34px;
            outline: none;
            padding: 0 10px;
            width: 100%;
          }
          .anti-recall-rkey__input::placeholder { color: var(--text_secondary, #8a8f98); }
          .anti-recall-rkey__input:focus {
            border-color: var(--brand_standard, #1478ff);
            box-shadow: 0 0 0 1px var(--brand_standard, #1478ff);
          }
          .anti-recall-rkey__input:disabled { opacity: .5; }
          .anti-recall-rkey__actions {
            align-items: center;
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 16px;
            min-height: 34px;
          }
          .anti-recall-rkey__button {
            align-items: center;
            background: var(--fill_standard_secondary, rgba(127, 127, 127, .09));
            border: 1px solid var(--fill_standard_primary, rgba(127, 127, 127, .18));
            border-radius: 6px;
            color: var(--text_primary, #202124);
            cursor: pointer;
            display: inline-flex;
            font: inherit;
            gap: 7px;
            height: 34px;
            justify-content: center;
            line-height: 20px;
            padding: 0 12px;
            transition: background-color .14s ease, border-color .14s ease, color .14s ease;
            white-space: nowrap;
          }
          .anti-recall-rkey__button:hover:not(:disabled) { background: var(--overlay_hover, rgba(127, 127, 127, .14)); }
          .anti-recall-rkey__button:active:not(:disabled) { background: var(--overlay_pressed, rgba(127, 127, 127, .2)); }
          .anti-recall-rkey__button:focus-visible {
            outline: 2px solid var(--brand_standard, #1478ff);
            outline-offset: 2px;
          }
          .anti-recall-rkey__button:disabled { cursor: default; opacity: .42; }
          .anti-recall-rkey__result {
            color: var(--text_secondary, #72777f);
            font-size: 12px;
            line-height: 18px;
            overflow-wrap: anywhere;
          }
          .anti-recall-rkey__result[hidden] { display: none; }
          .anti-recall-rkey__result--ok { color: #23834f; }
          .anti-recall-rkey__result--error { color: var(--text_error, #c73a36); }
          @media (prefers-color-scheme: light) { .text_color { color: black; } }
          @media (prefers-color-scheme: dark) { .text_color { color: white; } }
        </style>
      </setting-item>
    </plugin-menu>
  `;

  const menu = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector("plugin-menu");
  if (!menu) return;

  const clearBtn = menu.querySelector<HTMLButtonElement>("#clearDb");
  clearBtn?.addEventListener("click", async () => {
    await window.anti_recall.clearDb();
  });

  menu.querySelector<HTMLButtonElement>("#viewRecalled")?.addEventListener("click", () => {
    window.anti_recall.openRecallViewer();
  });

  const maxMsgLimit = menu.querySelector<HTMLInputElement>("#maxMsgLimit");
  maxMsgLimit?.addEventListener("blur", async () => {
    const v = Number.parseFloat(maxMsgLimit.value);
    if (v <= 0 || v > 99_999_999) {
      alert("你的数量输入有误！将不会保存，请重新输入");
      return;
    }
    currentConfig.maxMsgSaveLimit = v;
    await window.anti_recall.saveConfig(currentConfig);
  });

  const deletePerTime = menu.querySelector<HTMLInputElement>("#deletePerTime");
  deletePerTime?.addEventListener("blur", async () => {
    const v = Number.parseFloat(deletePerTime.value);
    if (v <= 0 || v > 99_999) {
      alert("你的数量输入有误！将不会保存，请重新输入");
      return;
    }
    currentConfig.deleteMsgCountPerTime = v;
    await window.anti_recall.saveConfig(currentConfig);
  });

  const colorInput = menu.querySelector<HTMLInputElement>(".pick-color");
  if (colorInput) {
    colorInput.value = currentConfig.mainColor;
    colorInput.addEventListener("change", async () => {
      currentConfig.mainColor = colorInput.value;
      await window.anti_recall.saveConfig(currentConfig);
    });
  }

  const switchSaveDb = menu.querySelector<HTMLElement>("#switchSaveDb");
  const storageRow = menu.querySelector<HTMLElement>("#storageStatusRow");

  if (switchSaveDb && storageRow) {
    setSwitchActive(switchSaveDb, currentConfig.saveDb === true);
    storageRow.classList.toggle("hidden", !currentConfig.saveDb);

    switchSaveDb.addEventListener("click", async () => {
      const next = !switchSaveDb.classList.contains("is-active");
      setSwitchActive(switchSaveDb, next);
      currentConfig.saveDb = next;
      storageRow.classList.toggle("hidden", !next);
      await window.anti_recall.saveConfig(currentConfig);
      if (next) await refreshStorageStatus(menu);
    });

    if (currentConfig.saveDb) await refreshStorageStatus(menu);
  }

  const switchSaveImages = menu.querySelector<HTMLElement>("#switchSaveImages");
  if (switchSaveImages) {
    setSwitchActive(
      switchSaveImages,
      currentConfig.saveImagesToDataDir === true,
    );
    switchSaveImages.addEventListener("click", async () => {
      const next = !switchSaveImages.classList.contains("is-active");
      setSwitchActive(switchSaveImages, next);
      currentConfig.saveImagesToDataDir = next;
      await window.anti_recall.saveConfig(currentConfig);
    });
  }

  const switchPeriodic = menu.querySelector<HTMLElement>(
    "#switchPeriodicCleanup",
  );
  const periodicSub = menu.querySelector<HTMLElement>("#periodicCleanupSub");
  if (switchPeriodic && periodicSub) {
    setSwitchActive(
      switchPeriodic,
      currentConfig.enablePeriodicCleanup !== false,
    );
    periodicSub.classList.toggle(
      "hidden",
      currentConfig.enablePeriodicCleanup === false,
    );
    switchPeriodic.addEventListener("click", async () => {
      const next = !switchPeriodic.classList.contains("is-active");
      setSwitchActive(switchPeriodic, next);
      currentConfig.enablePeriodicCleanup = next;
      periodicSub.classList.toggle("hidden", !next);
      await window.anti_recall.saveConfig(currentConfig);
    });
  }

  const switchAntiSelf = menu.querySelector<HTMLElement>(
    "#switchAntiRecallSelf",
  );
  if (switchAntiSelf) {
    setSwitchActive(switchAntiSelf, currentConfig.isAntiRecallSelfMsg === true);
    switchAntiSelf.addEventListener("click", async () => {
      const next = !switchAntiSelf.classList.contains("is-active");
      setSwitchActive(switchAntiSelf, next);
      currentConfig.isAntiRecallSelfMsg = next;
      await window.anti_recall.saveConfig(currentConfig);
    });
  }

  const switchNapcatRkey = menu.querySelector<HTMLElement>("#switchNapcatRkey");
  const napcatRkeyCfg = menu.querySelector<HTMLElement>("#napcatRkeyCfg");
  if (switchNapcatRkey && napcatRkeyCfg) {
    setSwitchActive(switchNapcatRkey, currentConfig.enableNapcatRkey === true);
    napcatRkeyCfg.classList.toggle(
      "hidden",
      currentConfig.enableNapcatRkey !== true,
    );
    switchNapcatRkey.addEventListener("click", async () => {
      const next = !switchNapcatRkey.classList.contains("is-active");
      setSwitchActive(switchNapcatRkey, next);
      currentConfig.enableNapcatRkey = next;
      napcatRkeyCfg.classList.toggle("hidden", !next);
      await window.anti_recall.saveConfig(currentConfig);
    });
  }

  const napcatRkeyUrlInput =
    menu.querySelector<HTMLInputElement>("#napcatRkeyUrl");
  napcatRkeyUrlInput?.addEventListener("blur", async () => {
    currentConfig.napcatRkeyUrl = napcatRkeyUrlInput.value.trim();
    await window.anti_recall.saveConfig(currentConfig);
  });

  const napcatRkeyTokenInput =
    menu.querySelector<HTMLInputElement>("#napcatRkeyToken");
  napcatRkeyTokenInput?.addEventListener("blur", async () => {
    currentConfig.napcatRkeyToken = napcatRkeyTokenInput.value.trim();
    await window.anti_recall.saveConfig(currentConfig);
  });

  const testNapcatBtn =
    menu.querySelector<HTMLButtonElement>("#testNapcatRkey");
  const testNapcatResult = menu.querySelector<HTMLElement>(
    "#napcatRkeyTestResult",
  );
  if (testNapcatBtn && testNapcatResult) {
    testNapcatBtn.addEventListener("click", async () => {
      const url = napcatRkeyUrlInput?.value.trim() ?? "";
      const token = napcatRkeyTokenInput?.value.trim() ?? "";
      testNapcatBtn.disabled = true;
      testNapcatResult.hidden = false;
      testNapcatResult.className = "anti-recall-rkey__result";
      testNapcatResult.textContent = "测试中...";
      try {
        const ret = await window.anti_recall.testNapcatRkey(url, token);
        console.log("[Anti-Recall] napcat rkey test result:", ret);
        if (ret.ok && ret.data) {
          const d = ret.data;
          const expire = new Date(d.expired_time * 1000).toLocaleString();
          testNapcatResult.classList.add("anti-recall-rkey__result--ok");
          testNapcatResult.textContent = `连接成功 ✓\nprivate: ${d.private_rkey}\ngroup: ${d.group_rkey}\n过期: ${expire}`;
        } else {
          testNapcatResult.classList.add("anti-recall-rkey__result--error");
          testNapcatResult.textContent = `测试失败: ${ret.error ?? "未知错误"}`;
        }
      } catch (e) {
        console.error("[Anti-Recall] napcat rkey test error:", e);
        testNapcatResult.classList.add("anti-recall-rkey__result--error");
        testNapcatResult.textContent = `测试异常: ${String(e)}`;
      } finally {
        testNapcatBtn.disabled = false;
        testNapcatResult.style.whiteSpace = "pre-wrap";
      }
    });
  }

  const switchShadow = menu.querySelector<HTMLElement>("#switchShadow");
  if (switchShadow) {
    setSwitchActive(switchShadow, currentConfig.enableShadow !== false);
    switchShadow.addEventListener("click", async () => {
      const next = !switchShadow.classList.contains("is-active");
      setSwitchActive(switchShadow, next);
      currentConfig.enableShadow = next;
      await window.anti_recall.saveConfig(currentConfig);
    });
  }

  const switchTip = menu.querySelector<HTMLElement>("#switchTip");
  if (switchTip) {
    setSwitchActive(switchTip, currentConfig.enableTip !== false);
    switchTip.addEventListener("click", async () => {
      const next = !switchTip.classList.contains("is-active");
      setSwitchActive(switchTip, next);
      currentConfig.enableTip = next;
      await window.anti_recall.saveConfig(currentConfig);
    });
  }

  container.appendChild(menu);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function refreshStorageStatus(menu: Element): Promise<void> {
  const statusEl = menu.querySelector<HTMLElement>("#storageStatus");
  if (!statusEl) return;
  if (!window.anti_recall?.getStorageStatus) {
    statusEl.textContent = "";
    return;
  }

  try {
    const status = await window.anti_recall.getStorageStatus();
    statusEl.textContent = `已存 ${status.recordCount} 条，${status.shardCount} 个分片，共 ${formatBytes(status.totalBytes)}`;
    statusEl.style.color = "";
  } catch {
    statusEl.textContent = "";
  }
}

async function applyCssFromConfig(): Promise<void> {
  currentConfig = await getNowConfig();

  const old = document.querySelector<HTMLStyleElement>("#anti-recall-css");
  old?.remove();

  const style = document.createElement("style");
  style.type = "text/css";
  style.id = "anti-recall-css";

  let css = `
    .message-content__wrapper {
      color: var(--bubble_guest_text);
      display: flex;
      grid-row-start: content;
      grid-column-start: content;
      grid-row-end: content;
      grid-column-end: content;
      max-width: -webkit-fill-available;
      min-height: 38px;
      overflow: visible !important;
      border-radius: 10px;
    }

    .message-content__wrapper.message-content-recalled-parent { padding: 0px !important; }

    .message-content-recalled-parent {
      border-radius: 10px;
      position: relative;
      overflow: unset !important;
      padding-bottom: 6px;
  `;

  if (currentConfig.enableShadow === true) {
    css += `
      margin-top: 3px;
      margin-left: 3px;
      margin-right: 3px;
      margin-bottom: 25px;
      box-shadow: 0px 0px 8px 5px ${currentConfig.mainColor} !important;
    `;
  } else {
    css += "margin-bottom: 15px;";
  }

  css += `
    }

    .forward-msg.message-content-recalled-parent,
    .multi-forward-msg.message-content-recalled-parent {
      box-shadow: 0px 0px 8px 5px ${currentConfig.mainColor} !important;
      margin-bottom: 25px !important;
    }

    .recalledNoMargin { margin-top: 0px !important; }

    .message-content-recalled-parent.forward-msg,
    .message-content-recalled-parent.multi-forward-msg {
      margin: 4px 3px 25px;
      border-radius: 10px;
    }

    .message-content-recalled {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      font-size: 12px;
      white-space: nowrap;
      background-color: var(--background-color-05);
      backdrop-filter: blur(28px);
      padding: 4px 8px;
      margin-bottom: 2px;
      border-radius: 6px;
      box-shadow: var(--box-shadow);
      transition: 300ms;
      transform: translateX(-30%);
      opacity: 0;
      pointer-events: none;
      color: ${currentConfig.mainColor};
    }
  `;

  style.innerHTML = css;
  document.head.appendChild(style);
}

async function setupMainWindowPatches(): Promise<void> {
  if (!window.anti_recall) return;

  window.anti_recall.repatchCss(() => {
    void applyCssFromConfig();
  });

  window.anti_recall.recallTip((_evt, msgId) => {
    console.log("[Anti-Recall]", "尝试反撤回消息ID", msgId);
    void markRecalledById(String(msgId));
  });

  window.anti_recall.recallTipList((_evt, ids) => {
    recalledIds = (ids ?? []).map(String);
    void markRecalledInView();
  });

  await applyCssFromConfig();

  let throttled = false;
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type !== "childList") continue;
      const first = m.addedNodes?.[0] as any as HTMLElement | undefined;
      if (first?.classList?.contains("message-content-recalled")) continue;
      if (throttled) continue;
      throttled = true;
      setTimeout(() => {
        throttled = false;
        void markRecalledInView();
      }, 50);
    }
  });

  const timer = setInterval(() => {
    const msgList = document.querySelector(".ml-list.list");
    if (!msgList) return;
    clearInterval(timer);
    console.log("[Anti-Recall]", "检测到聊天区域，已在当前页面加载反撤回");
    observer.observe(msgList, { childList: true, subtree: true });
  }, 100);
}

async function markRecalledInView(): Promise<void> {
  const nodes = document
    .querySelector(".chat-msg-area__vlist")
    ?.querySelectorAll<HTMLElement>(".ml-item");
  if (!nodes) return;

  currentConfig = await getNowConfig();

  for (const item of nodes) {
    const id = item.id;
    if (!id) continue;
    if (!recalledIds.some((x) => x === id)) continue;

    try {
      const a = item.querySelector<HTMLElement>(
        `div[id='${id}-msgContainerMsgContent']`,
      );
      const b = item.querySelector<HTMLElement>(`div[id='${id}-msgContent']`);
      const c = item
        .querySelector<HTMLElement>(`div[id='ml-${id}']`)
        ?.querySelector<HTMLElement>(".msg-content-container");
      const d = item.querySelector<HTMLElement>(
        `div[id='ark-msg-content-container_${id}']`,
      );
      const forward = item.querySelector<HTMLElement>(
        [
          `.multi-forward-msg[data-id='${id}']`,
          `[data-msgid='${id}'].forward-msg`,
          `.forward-msg[data-id='${id}']`,
          `div[id='ml-${id}-msgContentForward']`,
          `div[id='${CSS.escape(id)}-msgContentForward']`,
        ].join(","),
      );

      const forwardedNodes = item.querySelectorAll<HTMLElement>(
        [
          ".forward-msg",
          ".multi-forward-msg",
          "[class*='forward'][class*='msg']",
        ].join(","),
      );
      if (forwardedNodes.length) {
        console.log("[Anti-Recall]", "匹配转发消息节点", {
          msgId: id,
          count: forwardedNodes.length,
          classes: [...forwardedNodes].map((node) => node.className),
        });
        await markForwardedMessage(forwardedNodes[0], id);
      }

      if (forward) {
        await markForwardedMessage(forward, id);
      } else if (a) {
        if (a.classList.contains("gray-tip-message")) continue;
        await markRecalled(a);
      } else if (b?.parentElement) {
        if (b.classList.contains("gray-tip-message")) continue;
        await markRecalled(b.parentElement);
      } else if (c?.parentElement) {
        if (c.classList.contains("gray-tip-message")) continue;
        await markRecalled(c.parentElement);
      } else if (d) {
        if (d.classList.contains("gray-tip-message")) continue;
        d.classList.add("recalledNoMargin");
        await markRecalled(d.parentElement ?? d);
      } else {
        let fallback = item.querySelector<HTMLElement>(
          ".msg-content-container",
        );
        if (!fallback)
          fallback = item.querySelector<HTMLElement>(".file-message--content");
        if (fallback) await markRecalled(fallback);
      }
    } catch (e) {
      console.log("[Anti-Recall]", "反撤回消息时出错", e);
    }
  }
}

async function markRecalledById(msgId: string): Promise<void> {
  const t = document.getElementById(`${msgId}-msgContainerMsgContent`);
  const p = document.getElementById(`${msgId}-msgContent`);
  const r = document
    .getElementById(`ml-${msgId}`)
    ?.querySelector<HTMLElement>(".msg-content-container");
  const ark = document.getElementById(`ark-msg-content-container_${msgId}`);
  const forward = document.querySelector<HTMLElement>(
    [
      `.multi-forward-msg[data-id='${msgId}']`,
      `[data-msgid='${msgId}'].forward-msg`,
      `.forward-msg[data-id='${msgId}']`,
      `#ml-${CSS.escape(msgId)}-msgContentForward`,
      `#${CSS.escape(msgId)}-msgContentForward`,
    ].join(","),
  );

  if (forward) {
    await markForwardedMessage(forward, msgId);
    return;
  }

  if (t) {
    if (t.classList.contains("gray-tip-message")) return;
    await markRecalled(t);
    return;
  }

  if (p?.parentElement) {
    if (p.classList.contains("gray-tip-message")) return;
    await markRecalled(p.parentElement);
    return;
  }

  if (r?.parentElement) {
    if (r.classList.contains("gray-tip-message")) return;
    await markRecalled(r.parentElement);
    return;
  }

  if (ark) {
    if (ark.classList.contains("gray-tip-message")) return;
    ark.classList.add("recalledNoMargin");
    await markRecalled(ark.parentElement ?? ark);
    return;
  }

  const bySelector = document.querySelector<HTMLElement>(
    `.ml-item[id='${msgId}'] .msg-content-container`,
  );
  if (bySelector) await markRecalled(bySelector);
}

async function markForwardedMessage(node: HTMLElement, msgId: string): Promise<void> {
  const bubble =
    (node.matches(".forward-msg") || node.matches(".multi-forward-msg")
      ? node
      : node.querySelector<HTMLElement>(".forward-msg, .multi-forward-msg")) ??
    node;

  console.log("[Anti-Recall]", "标记转发消息阴影", {
    msgId,
    target: bubble,
    className: bubble.className,
  });

  await markRecalled(bubble);
}

async function markRecalled(container: HTMLElement): Promise<void> {
  if (!container) return;

  const existingTips = container.querySelectorAll<HTMLElement>(
    ":scope > .message-content-recalled",
  );
  if (existingTips.length > 1) {
    for (const tip of [...existingTips].slice(1)) tip.remove();
  }

  const isMarked =
    container.classList.contains("message-content-recalled-parent") ||
    existingTips.length > 0;
  if (isMarked) {
    container.classList.add("message-content-recalled-parent");
    return;
  }

  if (container.classList.contains("message-content__wrapper")) {
    container.classList.add("message-content-recalled-parent");
  } else {
    container.classList.add("message-content-recalled-parent", "recalledNoMargin");
  }

  if (currentConfig.enableTip === true) {
    const tip = document.createElement("div");
    tip.innerText = "已撤回";
    tip.classList.add("message-content-recalled");
    container.appendChild(tip);
    setTimeout(() => {
      tip.style.transform = "translateX(0)";
      tip.style.opacity = "1";
    }, 5);
  }
}
