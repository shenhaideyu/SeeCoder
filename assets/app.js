const chapters = [
  { id: "01", group: "先看全局", title: "SeeCoder 是怎样的系统", file: "01-overview.html" },
  { id: "02", group: "先看全局", title: "一次任务怎样完成", file: "02-task-journey.html" },
  { id: "03", group: "先看全局", title: "核心模块怎样分工", file: "03-architecture.html" },
  { id: "04", group: "理解核心", title: "Session、事件与分支", file: "04-session-history.html" },
  { id: "05", group: "理解核心", title: "上下文怎样保持清醒", file: "05-context.html" },
  { id: "06", group: "理解核心", title: "TurnRunner 主循环", file: "06-agent-loop.html" },
  { id: "07", group: "理解核心", title: "动态干预与生命周期", file: "07-model-parsing.html" },
  { id: "08", group: "理解核心", title: "工具执行与并发控制", file: "08-tools.html" },
  { id: "09", group: "保证可靠", title: "模型协议与流式解析", file: "09-stop-errors.html" },
  { id: "10", group: "保证可靠", title: "终止、安全与恢复", file: "10-safety-recovery.html" },
  { id: "11", group: "保证可靠", title: "测试怎样证明系统可信", file: "11-testing.html" },
  { id: "12", group: "进入源码", title: "源码阅读路线", file: "12-defense.html" },
];

const state = {
  current: 0,
  contents: new Map(),
  completed: new Set(JSON.parse(localStorage.getItem("seecoder-docs-completed") || "[]")),
};

const $ = (selector) => document.querySelector(selector);
const article = $("#article");
const chapterNav = $("#chapterNav");
const searchInput = $("#searchInput");
const searchResults = $("#searchResults");

const wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

async function fetchChapter(chapter) {
  // 以当前脚本 URL 为基准，兼容本地根路径和 GitHub Pages 的 /SeeCoder/ 子路径。
  const chapterUrl = new URL(`../chapters/${chapter.file}`, import.meta.url);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(chapterUrl, { cache: attempt === 0 ? "default" : "reload" });
      if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(350 * (attempt + 1));
    }
  }
  throw lastError;
}

function renderNavigation() {
  let group = "";
  chapterNav.innerHTML = chapters.map((chapter, index) => {
    const label = chapter.group !== group ? `<div class="nav-group-label">${chapter.group}</div>` : "";
    group = chapter.group;
    const checked = state.completed.has(chapter.id) ? "✓" : "";
    return `${label}<button class="nav-item ${index === state.current ? "active" : ""}" data-index="${index}" type="button">
      <span class="nav-number">${chapter.id}</span><span class="nav-title">${chapter.title}</span><span class="nav-check">${checked}</span>
    </button>`;
  }).join("");

  chapterNav.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => navigate(Number(button.dataset.index)));
  });
  const percentage = (state.completed.size / chapters.length) * 100;
  $("#progressText").textContent = `${state.completed.size} / ${chapters.length}`;
  $("#progressBar").style.width = `${percentage}%`;
}

async function loadChapter(index) {
  const chapter = chapters[index];
  if (!state.contents.has(chapter.id)) {
    state.contents.set(chapter.id, await fetchChapter(chapter));
  }
  return state.contents.get(chapter.id);
}

function buildOutline() {
  const headings = [...article.querySelectorAll("h2")];
  headings.forEach((heading, index) => { heading.id = `section-${index + 1}`; });
  $("#pageOutline").innerHTML = headings.map((heading) =>
    `<a class="outline-link" href="#${heading.id}">${heading.textContent}</a>`
  ).join("");
}

function resolveChapterAssets() {
  article.querySelectorAll("img").forEach((image) => {
    const declaredPath = image.dataset.docAsset || image.getAttribute("src") || "";
    const assetPath = declaredPath.includes("assets/")
      ? declaredPath.split("assets/").pop()
      : declaredPath.replace(/^\.\//, "");
    if (!assetPath) return;
    // 以 app.js 所在的 assets 目录为根，而不是以浏览器地址栏或章节文件为根。
    image.src = new URL(`./${assetPath}`, import.meta.url).href;
  });
}

async function navigate(index, updateHash = true) {
  if (index < 0 || index >= chapters.length) return;
  state.current = index;
  article.innerHTML = '<div class="loading">正在加载章节…</div>';
  try {
    article.innerHTML = await loadChapter(index);
    resolveChapterAssets();
    state.completed.add(chapters[index].id);
    localStorage.setItem("seecoder-docs-completed", JSON.stringify([...state.completed]));
    $("#chapterCrumb").textContent = chapters[index].title;
    document.title = `${chapters[index].title} · SeeCoder 技术教程`;
    configureChapterButtons();
    buildOutline();
    renderNavigation();
    closeSidebar();
    window.scrollTo({ top: 0, behavior: "instant" });
    if (updateHash) history.replaceState(null, "", `#chapter-${chapters[index].id}`);
  } catch (error) {
    $("#pageOutline").replaceChildren();
    const localHint = location.protocol === "file:"
      ? "请使用 start.ps1 启动本地站点，不要直接双击 index.html。"
      : "网络请求未完成，请稍后重新加载本章。";
    article.innerHTML = `<div class="callout danger"><span class="callout-title">章节暂时无法加载</span><p>${localHint}</p><button class="retry-button" id="retryChapter" type="button">重新加载本章</button></div>`;
    $("#retryChapter").addEventListener("click", () => navigate(index, false));
  }
}

function configureChapterButtons() {
  const prev = $("#prevChapter");
  const next = $("#nextChapter");
  prev.disabled = state.current === 0;
  next.disabled = state.current === chapters.length - 1;
  if (!prev.disabled) prev.innerHTML = `<small>← 上一章</small><strong>${chapters[state.current - 1].title}</strong>`;
  if (!next.disabled) next.innerHTML = `<small>下一章 →</small><strong>${chapters[state.current + 1].title}</strong>`;
}

async function preloadForSearch() {
  await Promise.all(chapters.map((_, index) => loadChapter(index)));
}

function plainText(html) {
  const node = document.createElement("div");
  node.innerHTML = html;
  return node.textContent.replace(/\s+/g, " ").trim();
}

async function search(query) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) { searchResults.hidden = true; return; }
  searchResults.hidden = false;
  searchResults.innerHTML = '<div class="search-empty">正在搜索…</div>';
  await preloadForSearch();
  const matches = chapters.map((chapter, index) => {
    const text = plainText(state.contents.get(chapter.id));
    const position = text.toLocaleLowerCase().indexOf(normalized);
    if (position < 0 && !chapter.title.toLocaleLowerCase().includes(normalized)) return null;
    const start = Math.max(0, position - 38);
    const excerpt = position >= 0 ? text.slice(start, start + 110) : "章节标题匹配";
    return { chapter, index, excerpt: `${start > 0 ? "…" : ""}${excerpt}${start + 110 < text.length ? "…" : ""}` };
  }).filter(Boolean).slice(0, 8);

  searchResults.innerHTML = matches.length ? matches.map((match) =>
    `<button class="search-result" data-index="${match.index}" type="button"><strong>${match.chapter.id} · ${match.chapter.title}</strong><span>${match.excerpt}</span></button>`
  ).join("") : '<div class="search-empty">没有找到相关内容</div>';
  searchResults.querySelectorAll(".search-result").forEach((button) => {
    button.addEventListener("click", () => {
      navigate(Number(button.dataset.index));
      searchInput.value = "";
      searchResults.hidden = true;
    });
  });
}

function openSidebar() { $("#sidebar").classList.add("open"); $("#sidebarMask").classList.add("open"); }
function closeSidebar() { $("#sidebar").classList.remove("open"); $("#sidebarMask").classList.remove("open"); }

function updatePageProgress() {
  const root = document.documentElement;
  const height = root.scrollHeight - root.clientHeight;
  $("#pageProgress").style.width = `${height > 0 ? (root.scrollTop / height) * 100 : 0}%`;
}

function initializeTheme() {
  const stored = localStorage.getItem("seecoder-docs-theme");
  const theme = stored || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  $("#themeToggle").textContent = theme === "dark" ? "切换浅色主题" : "切换深色主题";
}

$("#prevChapter").addEventListener("click", () => navigate(state.current - 1));
$("#nextChapter").addEventListener("click", () => navigate(state.current + 1));
$("#menuButton").addEventListener("click", openSidebar);
$("#sidebarMask").addEventListener("click", closeSidebar);
searchInput.addEventListener("input", (event) => search(event.target.value));
document.addEventListener("click", (event) => {
  if (!event.target.closest(".search-box") && !event.target.closest(".search-results")) searchResults.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); searchInput.focus(); searchInput.select(); }
  if (event.key === "Escape") { searchResults.hidden = true; closeSidebar(); }
});
$("#themeToggle").addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("seecoder-docs-theme", theme);
  $("#themeToggle").textContent = theme === "dark" ? "切换浅色主题" : "切换深色主题";
});
$("#fontDown").addEventListener("click", () => {
  const size = Math.max(15, Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue("--article-size")) - 1);
  document.documentElement.style.setProperty("--article-size", `${size}px`);
});
$("#fontUp").addEventListener("click", () => {
  const size = Math.min(21, Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue("--article-size")) + 1);
  document.documentElement.style.setProperty("--article-size", `${size}px`);
});
window.addEventListener("scroll", updatePageProgress, { passive: true });

initializeTheme();
renderNavigation();
const hashId = location.hash.match(/chapter-(\d+)/)?.[1];
const initialIndex = Math.max(0, chapters.findIndex((chapter) => chapter.id === hashId));
navigate(initialIndex, false);
