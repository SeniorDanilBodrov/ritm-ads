import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  useRef,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  BookOpen,
  ChartLine,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  Database,
  ExternalLink,
  FileText,
  Grid2X2,
  HelpCircle,
  History,
  Images,
  List,
  LoaderCircle,
  LogOut,
  Menu,
  Megaphone,
  Moon,
  MoreHorizontal,
  PanelsTopLeft,
  Pause,
  Play,
  Plus,
  Plug,
  RefreshCw,
  Search,
  Send,
  SlidersHorizontal,
  Split,
  Sparkles,
  Store,
  ShieldCheck,
  Sun,
  TrendingUp,
  Trash2,
  Undo2,
  Wallet,
  X,
} from "lucide-react";
import type {
  Workspace,
  Session,
  Business,
  Change,
  Campaign,
  DirectPlan,
  DirectNetworkPlan,
  AnyDirectPlan,
  DirectAbPlan,
  DirectControlReview,
  LiveShadowReview,
  AcceptanceRunReport,
  AcceptanceRun,
} from "./types";
import ritmMark from "./assets/ritm-mark.png";
import ritmGrowthSeed from "./assets/ritm-growth-seed.png";
import ritmGrowthSprout from "./assets/ritm-growth-sprout.png";
import ritmGrowthYoung from "./assets/ritm-growth-young.png";
import ritmGrowthSapling from "./assets/ritm-growth-sapling.png";
import ritmGrowthTree from "./assets/ritm-growth-tree.png";
import "./styles.css";
import "./styles-v2.css";
import "./styles-autopilot.css";

const money = (v: number | null) =>
  v === null
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(
        v / 100,
      ) + " ₽";
const count = (v: number | null) =>
  v === null ? "—" : new Intl.NumberFormat("ru-RU").format(v);
const rhythmGrowthImages = [
  ritmGrowthSeed,
  ritmGrowthSprout,
  ritmGrowthYoung,
  ritmGrowthSapling,
  ritmGrowthTree,
];
const date = (v: string) =>
  new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(
    new Date(v + "T12:00:00"),
  );
const time = (v: string, timezone: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(v));
const displayEventReason = (reason: string) =>
  reason ===
  "Подготовлен безопасный базовый план. Его можно улучшить после подключения локальной модели."
    ? "Подготовлен базовый план по данным бизнеса. Его можно уточнить позже."
    : reason;
async function api(
  path: string,
  body?: unknown,
  method = "POST",
  requestKey?: string,
  timeoutMs?: number,
) {
  const r = await fetch("/api" + path, {
    method: body === undefined ? "GET" : method,
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    headers:
      body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-Ritm-Request": "1",
            "Idempotency-Key": requestKey || crypto.randomUUID(),
          },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Не удалось выполнить запрос");
  return data;
}
const nav = [
  { id: "overview", name: "Итоги рекламы", icon: Grid2X2 },
  { id: "campaigns", name: "План и запуск", icon: Megaphone },
];
const advancedNav = [
  { id: "experiments", name: "Эксперименты", icon: Split },
  { id: "advisor", name: "Наблюдение Ритма", icon: ChartLine },
  { id: "reports", name: "Данные и отчёты", icon: Database },
  { id: "history", name: "История действий", icon: List },
];
const pageDetails: Record<
  string,
  {
    title: string;
    description: string;
    eyebrow: string;
    icon: React.ElementType;
  }
> = {
  overview: {
    title: "Ваша реклама",
    description: "Понятный итог, следующий шаг и состояние бюджета.",
    eyebrow: "Главная",
    icon: Grid2X2,
  },
  campaigns: {
    title: "План и запуск",
    description: "Ритм подготовит рекламу и проверит всё до запуска.",
    eyebrow: "Запуск рекламы",
    icon: Megaphone,
  },
  experiments: {
    title: "Эксперименты",
    description: "Сравнение вариантов объявлений по подтверждённым данным.",
    eyebrow: "Проверка гипотез",
    icon: Split,
  },
  advisor: {
    title: "Наблюдение Ритма",
    description:
      "Ритм наблюдает за результатом и объясняет, что стоит проверить.",
    eyebrow: "Только предложения",
    icon: ChartLine,
  },
  reports: {
    title: "Данные и отчёты",
    description:
      "Расходы, клики и обращения — с понятным источником каждой цифры.",
    eyebrow: "Понятные итоги",
    icon: Database,
  },
  history: {
    title: "История действий",
    description: "Записи об изменениях и причинах решений.",
    eyebrow: "Журнал изменений",
    icon: List,
  },
  connections: {
    title: "Страница и Директ",
    description:
      "Подключите рекламу и укажите, куда привести будущего клиента.",
    eyebrow: "Второй шаг",
    icon: Plug,
  },
  settings: {
    title: "О бизнесе",
    description:
      "Ритм использует эти данные, чтобы подготовить рекламу именно для вас.",
    eyebrow: "Первый шаг",
    icon: SlidersHorizontal,
  },
};
function workspaceEnvironment(
  demo: boolean,
  capabilities?: Workspace["capabilities"],
) {
  if (demo)
    return {
      tone: "demo",
      pill: "Демо",
      title: "Демонстрационные данные",
      description:
        "Изучайте сценарии на тестовых данных без подключения кабинета и списаний.",
    };
  if (capabilities?.directResumePilot)
    return {
      tone: "pilot",
      pill: "Пилот · показы",
      title: "Действия с реальной рекламой доступны",
      description:
        "Показы можно возобновить только после проверки кампании и отдельного подтверждения расходов.",
    };
  if (capabilities?.directModerationPilot)
    return {
      tone: "pilot",
      pill: "Пилот · модерация",
      title: "Доступна отправка на модерацию",
      description:
        "Проверенные объявления можно отправить в Директ. Показы запускаются отдельным действием.",
    };
  if (capabilities?.directWritePilot)
    return {
      tone: "safe",
      pill: "Безопасный запуск",
      title: "Доступно создание выключенной кампании",
      description:
        "После проверки и вашего подтверждения сервис создаст выключенный черновик. Показы и расходы не начнутся.",
    };
  return {
    tone: "safe",
    pill: "Наблюдение",
    title: "Ритм наблюдает и предлагает",
    description:
      "Ничего в рекламе не меняет. Можно читать данные кабинета и проверять план, но создание кампаний и показы выключены.",
  };
}
function Logo() {
  return (
    <div className="logo">
      <span className="logo-mark" aria-hidden="true">
        <img src={ritmMark} alt="" />
      </span>
      ритм<span className="logo-dot">.</span>
    </div>
  );
}
function Badge({
  children,
  tone = "green",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={"badge " + tone}>{children}</span>;
}
function Empty({
  title,
  text,
  action,
  kicker = "Пока нет данных",
  icon: Icon,
  children,
}: {
  title: string;
  text: string;
  action?: React.ReactNode;
  kicker?: string;
  icon?: React.ElementType;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      {Icon && (
        <span className="empty-mark" aria-hidden="true">
          <Icon size={21} strokeWidth={1.8} />
        </span>
      )}
      {kicker && <span className="empty-kicker">{kicker}</span>}
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
      {action}
    </div>
  );
}

type Theme = "light" | "dark";

const storageFallback = new Map<string, string>();
const safeStorage = {
  getItem(key: string) {
    try {
      return (
        window.localStorage.getItem(key) ?? storageFallback.get(key) ?? null
      );
    } catch {
      return storageFallback.get(key) ?? null;
    }
  },
  setItem(key: string, value: string) {
    storageFallback.set(key, value);
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // The in-memory value keeps the current session coherent.
    }
  },
  removeItem(key: string) {
    storageFallback.delete(key);
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Nothing else is required when persistent storage is unavailable.
    }
  },
};

const isAutopilotNotification = (event: Change) =>
  event.kind === "analysis" ||
  event.kind === "analysis_error" ||
  (event.kind === "control" && event.title.startsWith("Фоновый анализ"));

function getInitialTheme(): Theme {
  const saved = safeStorage.getItem("ritm-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function WorkspaceSwitcher({
  businesses,
  activeId,
  busy,
  selectBusiness,
  addBusiness,
}: {
  businesses: { id: string; name: string }[];
  activeId: string;
  busy: boolean;
  selectBusiness: (id: string) => void;
  addBusiness: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = businesses.find((business) => business.id === activeId);

  useEffect(() => {
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, []);

  useEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);

  const closeMenu = (returnFocus = false) => {
    setOpen(false);
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div className="workspace-switch" ref={containerRef}>
      <div className="business-avatar" aria-hidden="true">
        <Store size={18} strokeWidth={2} />
      </div>
      <div className="workspace-switch-copy">
        <span className="small muted">Мой бизнес</span>
        <button
          ref={triggerRef}
          type="button"
          className="workspace-switch-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls="business-switcher-menu"
          disabled={busy || businesses.length === 0}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <span title={current?.name || "Добавьте первый бизнес"}>
            {current?.name || "Добавьте первый бизнес"}
          </span>
          <ChevronDown size={15} aria-hidden="true" />
        </button>
      </div>
      <button
        type="button"
        className="add-business-button"
        aria-label="Добавить бизнес"
        title="Добавить бизнес"
        onClick={addBusiness}
      >
        <Plus size={15} />
      </button>
      {open && (
        <div
          id="business-switcher-menu"
          className="workspace-switch-menu"
          role="menu"
          aria-label="Выбрать бизнес"
          onKeyDown={(event) => {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "[role='menuitemradio']",
              ),
            );
            const currentIndex = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            if (event.key === "Escape") {
              event.preventDefault();
              closeMenu(true);
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              const nextIndex =
                (currentIndex + step + items.length) % items.length;
              items[nextIndex]?.focus();
            }
          }}
        >
          {businesses.map((business) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={business.id === activeId}
              autoFocus={business.id === activeId}
              key={business.id}
              onClick={() => {
                closeMenu();
                selectBusiness(business.id);
              }}
            >
              <span>{business.name}</span>
              {business.id === activeId && (
                <Check size={15} aria-hidden="true" />
              )}
            </button>
          ))}
          <button
            type="button"
            className="workspace-switch-menu-add"
            role="menuitem"
            onClick={() => {
              closeMenu();
              addBusiness();
            }}
          >
            <Plus size={15} aria-hidden="true" />
            Добавить бизнес
          </button>
        </div>
      )}
    </div>
  );
}

function App() {
  const [session, setSession] = useState<Session | null>(null),
    [ws, setWs] = useState<Workspace | null>(null),
    [businesses, setBusinesses] = useState<{ id: string; name: string }[]>([]),
    [activeId, setActiveId] = useState("");
  const [page, setPage] = useState("overview"),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [notificationsOpen, setNotificationsOpen] = useState(false),
    [notificationsReadAt, setNotificationsReadAt] = useState(0),
    [mobile, setMobile] = useState(false),
    [mobileMore, setMobileMore] = useState(false),
    [globalSearch, setGlobalSearch] = useState(""),
    [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [modal, setModal] = useState<
      "budget" | "business" | "business-edit" | "help" | null
    >(null),
    [confirmation, setConfirmation] = useState<{
      title: string;
      text: string;
      action: () => Promise<void>;
      actionLabel?: string;
      intent?: "primary" | "danger";
    } | null>(null);
  const selectedRef = useRef(activeId);
  const mainRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const mobileSheetRef = useRef<HTMLDialogElement>(null);
  const onboardingSeenFor = useRef<string | null>(null);
  const notificationRef = useRef<HTMLDivElement>(null);
  const notificationScopeRef = useRef<string | null>(null);
  const notificationToastRef = useRef<string | null>(null);
  selectedRef.current = activeId;
  const notificationScope =
    session?.user && ws
      ? `ritm:autopilot-notifications:${session.user.id}:${ws.id}`
      : "";
  const autopilotNotifications =
    ws?.events.filter(isAutopilotNotification) || [];
  const unreadNotifications = autopilotNotifications.filter(
    (event) => Date.parse(event.at) > notificationsReadAt,
  );
  const markNotificationsRead = () => {
    const readAt = Date.now();
    setNotificationsReadAt(readAt);
    if (notificationScope)
      safeStorage.setItem(notificationScope, String(readAt));
  };
  async function load(id = selectedRef.current) {
    const list = await api("/businesses");
    setBusinesses(list);
    if (!list.length) {
      setWs(null);
      return;
    }
    const target =
      id && list.some((b: { id: string }) => b.id === id) ? id : list[0].id;
    const data = await api(
      "/workspace?businessId=" + encodeURIComponent(target),
    );
    setWs(data);
    setActiveId(target);
  }
  useEffect(() => {
    api("/session")
      .then(async (s) => {
        setSession(s);
        if (s.user) await load();
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (loading || !session?.user) return;
    if (onboardingSeenFor.current === session.user.id) return;
    onboardingSeenFor.current = session.user.id;
    if (!ws && businesses.length === 0) setModal("business");
  }, [businesses.length, loading, session?.user, ws]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search),
      authError = params.get("authError");
    if (authError === "google-token-expired") {
      setError(
        "Google не подтвердил вход: время на компьютере или сервере не совпадает с текущим. Проверьте дату, время и часовой пояс, затем войдите ещё раз.",
      );
      params.delete("authError");
      const query = params.toString();
      window.history.replaceState(
        {},
        "",
        window.location.pathname +
          (query ? `?${query}` : "") +
          window.location.hash,
      );
    }
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const readAt = Number(safeStorage.getItem(notificationScope));
    setNotificationsReadAt(Number.isFinite(readAt) ? readAt : 0);
    setNotificationsOpen(false);
    notificationScopeRef.current = notificationScope || null;
    notificationToastRef.current = autopilotNotifications[0]?.id || null;
  }, [notificationScope]);
  useEffect(() => {
    if (!notificationScope) return;
    if (notificationScopeRef.current !== notificationScope) {
      notificationScopeRef.current = notificationScope;
      return;
    }
    const latest = unreadNotifications[0];
    if (!latest || notificationToastRef.current === latest.id) return;
    notificationToastRef.current = latest.id;
    setToast(`Рита: ${latest.title}. ${latest.reason}`);
  }, [notificationScope, unreadNotifications]);
  useEffect(() => {
    if (!ws?.state.shadowAnalysis) return;
    const timer = window.setInterval(() => {
      void load(ws.id).catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [ws?.id, ws?.state.shadowAnalysis]);
  useEffect(() => {
    if (ws?.state.remoteAiPlan?.status !== "pending") return;
    const timer = window.setInterval(() => {
      void load(ws.id).catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [ws?.id, ws?.state.remoteAiPlan?.status]);
  useEffect(() => {
    const run = ws?.acceptanceRuns?.[0];
    if (!run || !["pending", "running"].includes(run.status)) return;
    const timer = window.setInterval(() => {
      void load(ws.id).catch(() => undefined);
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [ws?.id, ws?.acceptanceRuns?.[0]?.id, ws?.acceptanceRuns?.[0]?.status]);
  useEffect(() => {
    if (!notificationsOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!notificationRef.current?.contains(event.target as Node))
        setNotificationsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNotificationsOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [notificationsOpen]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    safeStorage.setItem("ritm-theme", theme);
  }, [theme]);
  useEffect(() => {
    const title = loading
      ? "Загрузка"
      : !session?.user
        ? "Вход"
        : pageDetails[page]?.title || "Рабочее пространство";
    document.title = `${title} — Ритм`;
  }, [loading, page, session?.user]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(
          (event.target as HTMLElement).tagName,
        )
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (
        event.key === "Escape" &&
        document.activeElement === searchRef.current
      ) {
        setGlobalSearch("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  useEffect(() => {
    if (mobileMore && mobileSheetRef.current && !mobileSheetRef.current.open) {
      mobileSheetRef.current.showModal();
    }
  }, [mobileMore]);
  useLayoutEffect(() => {
    const reset = () => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };
    mainRef.current?.focus({ preventScroll: true });
    reset();
    const frame = requestAnimationFrame(reset);
    return () => cancelAnimationFrame(frame);
  }, [page]);
  async function perform(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function performWithResult(fn: () => Promise<void>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    await perform(async () => {
      await api("/logout", {});
      setSession(await api("/session"));
      setWs(null);
      setActiveId("");
      setMobileMore(false);
    });
  }
  async function cmd(action: string, payload: Record<string, unknown> = {}) {
    if (!ws) return;
    const result = await api(`/businesses/${ws.id}/command`, {
      action,
      payload,
    });
    await load(ws.id);
    setToast(
      action === "schedule"
        ? payload.enabled
          ? "Рита: включила наблюдение. Напишу, когда проверка будет готова."
          : "Наблюдение на паузе. Рита больше не запускает фоновые проверки."
        : result.message,
    );
  }
  async function demo() {
    await perform(async () => {
      await api("/demo", {});
      setSession(await api("/session"));
      await load();
    });
  }
  const select = (id: string) => {
    setPage(id);
    setError("");
    setMobile(false);
    setMobileMore(false);
    setGlobalSearch("");
  };
  const toggleTheme = () =>
    setTheme((value) => (value === "dark" ? "light" : "dark"));
  const themeLabel =
    theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему";
  if (loading)
    return (
      <div className="loading-screen">
        <Logo />
        <LoaderCircle className="spin" />
        <span>Готовим рабочее пространство</span>
      </div>
    );
  if (!session?.user)
    return (
      <div className="welcome">
        <div className="welcome-top">
          <Logo />
          <div className="welcome-top-actions">
            <span>Меньше настроек. Больше дела.</span>
            <button
              type="button"
              className="theme-toggle"
              aria-label={themeLabel}
              title={themeLabel}
              onClick={toggleTheme}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </div>
        <div className="welcome-layout">
          <section>
            <Badge>Реклама в вашем ритме</Badge>
            <h1>
              Ваш бизнес —<br />в центре внимания.
            </h1>
            <p className="welcome-copy">
              Расскажите о себе и задайте бюджет.
              <br />
              Ритм поможет запустить рекламу и разобраться
              <br />в результатах — простыми словами.
            </p>
            <div className="welcome-actions">
              {session?.googleConfigured ? (
                <div className="welcome-action-group welcome-action-primary">
                  <a className="button primary large" href="/auth/google/start">
                    Начать с Ритой <ArrowRight size={18} />
                  </a>
                  <small>
                    Войдёте через Google, затем Рита спросит о бизнесе.
                  </small>
                </div>
              ) : (
                <span className="google-pending">
                  Google-вход появится после настройки приложения
                </span>
              )}
              {session?.demoAvailable && (
                <div className="welcome-action-group welcome-action-demo">
                  <button
                    className="secondary large"
                    disabled={busy}
                    onClick={demo}
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <Play size={18} />
                    )}{" "}
                    Посмотреть демо <ArrowRight size={18} />
                  </button>
                  <small>
                    Тестовые данные. Реклама и деньги не затрагиваются.
                  </small>
                </div>
              )}
            </div>
            {error && (
              <div role="alert" className="error">
                {error}
              </div>
            )}
            <div className="welcome-benefits">
              <span>
                <ShieldCheck size={18} />
                Контроль бюджета
              </span>
              <span>
                <History size={18} />
                Понятные решения
              </span>
              <span>
                <Undo2 size={18} />
                История и откат
              </span>
            </div>
          </section>
          <div className="welcome-visual">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="visual-card visual-main">
              <span className="eyebrow">ВАША РЕКЛАМА РАБОТАЕТ</span>
              <h2>
                Пока вы занимаетесь
                <br />
                любимым делом.
              </h2>
              <div className="welcome-bars">
                {[25, 40, 35, 60, 52, 75, 70, 95].map((v, i) => (
                  <i key={i} style={{ height: v + "%" }} />
                ))}
              </div>
              <div className="visual-bottom">
                <span>Обращения растут</span>
                <TrendingUp size={25} />
              </div>
            </div>
            <div className="visual-card visual-small">
              <span className="check-icon">
                <Check size={20} />
              </span>
              <div>
                <b>Всё под контролем</b>
                <small>Изменения всегда видны</small>
              </div>
            </div>
            <span className="visual-tag">Демонстрация возможностей</span>
          </div>
        </div>
        <footer>
          Ритм — помощник для малого бизнеса{" "}
          <span>Версия 0.1 · Тестовый режим</span>
        </footer>
      </div>
    );
  const s = ws?.state;
  const environment = workspaceEnvironment(
    !!session.user.demo,
    ws?.capabilities,
  );
  const pageDetail = pageDetails[page] || pageDetails.overview;
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Перейти к содержимому
      </a>
      <button
        aria-label="Открыть меню"
        aria-expanded={mobile}
        aria-controls="workspace-sidebar"
        className="mobile-toggle"
        onClick={() => setMobile(!mobile)}
      >
        <Menu />
      </button>
      {mobile && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Закрыть меню"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        id="workspace-sidebar"
        aria-label="Навигация рабочего пространства"
        className={"sidebar " + (mobile ? "visible" : "")}
      >
        <Logo />
        <WorkspaceSwitcher
          businesses={businesses}
          activeId={activeId}
          busy={busy}
          selectBusiness={(id) => perform(() => load(id))}
          addBusiness={() => setModal("business")}
        />
        <div className="sidebar-navigation">
          <span className="nav-label">Ваш маршрут</span>
          <nav aria-label="Основной маршрут">
            <button
              aria-current={page === "settings" ? "page" : undefined}
              className={page === "settings" ? "selected" : ""}
              onClick={() => select("settings")}
            >
              <SlidersHorizontal size={19} />О бизнесе
            </button>
            <button
              aria-current={page === "connections" ? "page" : undefined}
              className={page === "connections" ? "selected" : ""}
              onClick={() => select("connections")}
            >
              <Plug size={19} />
              Страница и Директ
            </button>
            {nav
              .filter((item) => item.id === "campaigns")
              .map((n) => (
                <button
                  key={n.id}
                  aria-current={page === n.id ? "page" : undefined}
                  className={page === n.id ? "selected" : ""}
                  onClick={() => select(n.id)}
                >
                  <n.icon size={19} />
                  {n.name}
                </button>
              ))}
            {nav
              .filter((item) => item.id === "overview")
              .map((n) => (
                <button
                  key={n.id}
                  aria-current={page === n.id ? "page" : undefined}
                  className={page === n.id ? "selected" : ""}
                  onClick={() => select(n.id)}
                >
                  <n.icon size={19} />
                  {n.name}
                </button>
              ))}
          </nav>
          <nav className="sidebar-creative-nav" aria-label="Материалы рекламы">
            <span className="nav-label">Материалы рекламы</span>
            <button
              aria-current={page === "creatives" ? "page" : undefined}
              className={page === "creatives" ? "selected" : ""}
              onClick={() => select("creatives")}
            >
              <FileText size={19} />
              Изображения
            </button>
          </nav>
          <details
            className="advanced-nav"
            open={advancedNav.some((item) => item.id === page)}
          >
            <summary>Подробнее о рекламе</summary>
            <nav aria-label="Дополнительные разделы">
              {advancedNav.map((n) => (
                <button
                  key={n.id}
                  aria-current={page === n.id ? "page" : undefined}
                  className={page === n.id ? "selected" : ""}
                  onClick={() => select(n.id)}
                >
                  <n.icon size={19} />
                  {n.name}
                  {n.id === "experiments" &&
                  s?.experiments.filter((e) => e.status === "running")
                    .length ? (
                    <span className="nav-count">
                      {
                        s.experiments.filter((e) => e.status === "running")
                          .length
                      }
                    </span>
                  ) : null}
                </button>
              ))}
            </nav>
          </details>
        </div>
        <div className="sidebar-bottom">
          <div className="help-card">
            <div>
              <b>Разберёмся вместе</b>
            </div>
            <p>
              Как работает реклама
              <br />и что делает Ритм
            </p>
            <button onClick={() => setModal("help")}>
              Открыть справку <ArrowUpRight size={16} />
            </button>
          </div>
          <div className="profile">
            <span className="avatar">{session.user.name[0]}</span>
            <div>
              <b>{session.user.name}</b>
              <small>Владелец бизнеса</small>
            </div>
            <button aria-label="Выйти" title="Выйти" onClick={signOut}>
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-context">
            <span className="breadcrumb">Рабочее пространство</span>
            <ChevronRight size={14} />
            <b>
              {[...nav, ...advancedNav].find((n) => n.id === page)?.name ||
                (
                  {
                    creatives: "Изображения",
                    connections: "Подключить страницу и Директ",
                    settings: "О бизнесе",
                  } as Record<string, string>
                )[page]}
            </b>
          </div>
          <div className="global-search">
            <Search size={17} aria-hidden="true" />
            <input
              ref={searchRef}
              aria-label="Поиск по рабочему пространству"
              aria-expanded={!!globalSearch.trim()}
              aria-controls="workspace-search-results"
              value={globalSearch}
              onChange={(event) => setGlobalSearch(event.target.value)}
              placeholder="Найти раздел или кампанию"
            />
            {globalSearch.trim() ? (
              <button
                type="button"
                className="search-clear"
                aria-label="Очистить поиск"
                onClick={() => {
                  setGlobalSearch("");
                  searchRef.current?.focus();
                }}
              >
                <X size={15} />
              </button>
            ) : (
              <kbd>/</kbd>
            )}
            {globalSearch.trim() && (
              <div
                id="workspace-search-results"
                className="search-results"
                role="region"
                aria-label="Результаты поиска"
              >
                {Object.entries(pageDetails)
                  .filter(([, detail]) =>
                    `${detail.title} ${detail.description}`
                      .toLowerCase()
                      .includes(globalSearch.trim().toLowerCase()),
                  )
                  .map(([id, detail]) => {
                    const Icon = detail.icon;
                    return (
                      <button key={id} onClick={() => select(id)}>
                        <Icon size={17} />
                        <span>
                          <b>{detail.title}</b>
                          <small>{detail.eyebrow}</small>
                        </span>
                        <ArrowRight size={15} />
                      </button>
                    );
                  })}
                {s?.campaigns
                  .filter((campaign) =>
                    campaign.name
                      .toLowerCase()
                      .includes(globalSearch.trim().toLowerCase()),
                  )
                  .slice(0, 3)
                  .map((campaign) => (
                    <button
                      key={campaign.id}
                      onClick={() => select("campaigns")}
                    >
                      <Megaphone size={17} />
                      <span>
                        <b>{campaign.name}</b>
                        <small>Кампания</small>
                      </span>
                      <ArrowRight size={15} />
                    </button>
                  ))}
                {!Object.entries(pageDetails).some(([, detail]) =>
                  `${detail.title} ${detail.description}`
                    .toLowerCase()
                    .includes(globalSearch.trim().toLowerCase()),
                ) &&
                  !s?.campaigns.some((campaign) =>
                    campaign.name
                      .toLowerCase()
                      .includes(globalSearch.trim().toLowerCase()),
                  ) && (
                    <div className="search-empty">
                      Ничего не найдено. Попробуйте изменить запрос.
                    </div>
                  )}
              </div>
            )}
          </div>
          <div className="topbar-right">
            <span className={"environment-pill " + environment.tone}>
              <span /> {environment.pill}
            </span>
            <button
              type="button"
              aria-label={themeLabel}
              title={themeLabel}
              onClick={toggleTheme}
              className="icon-button theme-toggle"
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <div className="notification-wrap" ref={notificationRef}>
              <button
                type="button"
                aria-label={
                  unreadNotifications.length
                    ? `Уведомления: ${unreadNotifications.length} новых`
                    : "Уведомления"
                }
                aria-expanded={notificationsOpen}
                onClick={() => {
                  const next = !notificationsOpen;
                  setNotificationsOpen(next);
                  if (next) markNotificationsRead();
                }}
                className="notification"
              >
                <Bell size={19} />
                {unreadNotifications.length > 0 && (
                  <span className="notification-count" aria-hidden="true">
                    {unreadNotifications.length > 9
                      ? "9+"
                      : unreadNotifications.length}
                  </span>
                )}
              </button>
              {notificationsOpen && (
                <section
                  className="notification-panel"
                  role="region"
                  aria-label="Сообщения Риты"
                >
                  <header>
                    <div>
                      <b>Сообщения Риты</b>
                      <span>
                        {autopilotNotifications.length
                          ? "Показываем последние проверки"
                          : "Рита напишет после первой проверки"}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setNotificationsOpen(false);
                        select("history");
                      }}
                    >
                      История
                    </button>
                  </header>
                  <div className="notification-list">
                    {autopilotNotifications.length ? (
                      autopilotNotifications.slice(0, 4).map((event) => (
                        <button
                          type="button"
                          key={event.id}
                          onClick={() => {
                            setNotificationsOpen(false);
                            select("advisor");
                          }}
                        >
                          <b>{event.title}</b>
                          <span>{event.reason}</span>
                          <small>{time(event.at, ws!.state.timezone)}</small>
                        </button>
                      ))
                    ) : (
                      <p>
                        Включите автопилот, и Рита сообщит, когда закончит
                        первую проверку.
                      </p>
                    )}
                  </div>
                </section>
              )}
            </div>
            <span className="avatar small-avatar">{session.user.name[0]}</span>
          </div>
        </header>
        <main
          id="main-content"
          ref={mainRef}
          className={`page page-${page}`}
          tabIndex={-1}
        >
          {error && (
            <div className="error" role="alert">
              {error}
              <button aria-label="Скрыть ошибку" onClick={() => setError("")}>
                <X size={17} />
              </button>
            </div>
          )}
          {!ws ? (
            <Empty
              icon={pageDetail.icon}
              kicker=""
              title={
                page === "overview"
                  ? "Расскажите о бизнесе — Рита подготовит первый план"
                  : `Раздел «${pageDetail.title}» появится после знакомства с бизнесом`
              }
              text={
                page === "overview"
                  ? "Опишите услуги, город и бюджет обычными словами. Это займёт пару минут и ни к чему не обязывает."
                  : `Сначала Рите нужно понять, что вы предлагаете и кому. После этого раздел будет готов: ${pageDetail.description.toLowerCase()}`
              }
              action={
                <button
                  className="primary"
                  onClick={() => setModal("business")}
                >
                  <Sparkles size={16} />
                  Рассказать о бизнесе
                </button>
              }
            >
              <section
                className="empty-growth"
                aria-label="Путь запуска рекламы"
              >
                <div>
                  <b>Ваше дерево рекламы</b>
                  <span>Оно начнёт расти с первого ответа Рите.</span>
                </div>
                <ol aria-hidden="true">
                  {rhythmGrowthImages.map((image, index) => (
                    <li
                      className={index === 0 ? "current" : "pending"}
                      key={image}
                    >
                      <img src={image} alt="" />
                    </li>
                  ))}
                </ol>
              </section>
            </Empty>
          ) : (
            <>
              <div className="page-heading">
                <div className="page-heading-main">
                  <div>
                    <div className="eyebrow">{pageDetail.eyebrow}</div>
                    <h1>
                      {page === "overview" && s!.mode === "live"
                        ? "Ваш рекламный кабинет"
                        : pageDetail.title}
                    </h1>
                    <p>
                      {page === "overview" && s!.mode === "live"
                        ? `${s!.name} · Подключения, планы и отчёты в одном месте.`
                        : page === "overview"
                          ? `${s!.name} · ${pageDetail.description}`
                          : pageDetail.description}
                    </p>
                  </div>
                </div>
                <div className="heading-actions">
                  {page === "overview" ? (
                    <>
                      {s!.mode === "demo" && (
                        <span className="period">
                          <Clock3 size={16} />
                          {date(s!.periodStart)} — {date(s!.periodEnd)}
                        </span>
                      )}
                      <button
                        className="icon-button"
                        aria-label="Обновить данные"
                        disabled={busy}
                        onClick={() =>
                          perform(async () => {
                            await load();
                            setToast("Данные обновлены");
                          })
                        }
                      >
                        <RefreshCw size={17} />
                      </button>
                    </>
                  ) : page === "creatives" ? (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => perform(() => cmd("generate"))}
                    >
                      <FileText size={16} />
                      Подготовить тексты
                    </button>
                  ) : page === "history" ? (
                    <a
                      className="button secondary"
                      href={`/api/businesses/${ws.id}/export`}
                    >
                      <Download size={16} />
                      Скачать отчет
                    </a>
                  ) : null}
                </div>
              </div>
              {page === "overview" &&
                (s!.mode === "live" ? (
                  <LiveOverview ws={ws} select={select} />
                ) : (
                  <Overview
                    ws={ws}
                    busy={busy}
                    select={select}
                    budget={() => setModal("budget")}
                    tick={() => perform(() => cmd("tick"))}
                    pause={() =>
                      setConfirmation({
                        title: s!.running
                          ? "Приостановить рекламу?"
                          : "Возобновить рекламу?",
                        text: s!.running
                          ? "Новые показы в симуляции остановятся. Статистика и настройки сохранятся."
                          : "Активные направления продолжат работу в пределах своих лимитов.",
                        action: () => cmd("toggle"),
                      })
                    }
                  />
                ))}
              {page === "campaigns" && (
                <>
                  {s!.mode === "live" && ws.directChanges.length > 0 && (
                    <AcceptanceRunCard
                      ws={ws}
                      busy={busy}
                      onRun={() =>
                        perform(async () => {
                          await api(
                            `/businesses/${ws.id}/acceptance-run`,
                            {},
                            "POST",
                            crypto.randomUUID(),
                          );
                          await load(ws.id);
                          setToast(
                            "Тестовый прогон поставлен в очередь. Рабочая реклама не меняется",
                          );
                        })
                      }
                    />
                  )}
                  <Campaigns
                    ws={ws}
                    busy={busy}
                    navigate={select}
                    editBusiness={() => setModal("business-edit")}
                    budget={() => setModal("budget")}
                    launch={() =>
                      setConfirmation({
                        title: "Запустить тестовый план?",
                        text: "Создадим направления для поиска и знакомства с бизнесом. 10% бюджета останутся в резерве. Реальных списаний не будет.",
                        action: () => cmd("launch"),
                      })
                    }
                    toggle={(c) =>
                      setConfirmation({
                        title:
                          c.status === "active"
                            ? "Остановить направление?"
                            : "Возобновить направление?",
                        text: c.name,
                        action: () => cmd("campaign", { id: c.id }),
                      })
                    }
                    create={() => setModal("business")}
                    prepareAiPlan={() =>
                      perform(async () => {
                        const result = await api(
                          `/businesses/${ws.id}/ai-plan`,
                          {},
                        );
                        await load(ws.id);
                        setToast(
                          result.plan.provider === "ollama"
                            ? "Рита подготовила план рекламы"
                            : "Подготовлен безопасный базовый план",
                        );
                      })
                    }
                    dryRun={(plan) =>
                      perform(async () => {
                        const result = await api(
                          `/businesses/${ws.id}/direct/dry-run`,
                          plan,
                        );
                        await load(ws.id);
                        setToast(
                          `Ритм подготовил план: ${result.summary.ads} объявлений и ${result.summary.keywords} фраз. Реклама пока не менялась.`,
                        );
                      })
                    }
                    preflight={(id) =>
                      perform(async () => {
                        const report = await api(
                          `/businesses/${ws.id}/direct/${id}/preflight`,
                          {},
                        );
                        await load(ws.id);
                        if (report.ready)
                          requestAnimationFrame(() => {
                            document
                              .querySelector(`[data-direct-approval="${id}"]`)
                              ?.scrollIntoView({
                                block: "center",
                                behavior: window.matchMedia(
                                  "(prefers-reduced-motion: reduce)",
                                ).matches
                                  ? "auto"
                                  : "smooth",
                              });
                          });
                        setToast(
                          report.ready
                            ? "Проверка пройдена. Следующий шаг: подтвердить план."
                            : `Проверка выявила ${report.findings.filter((item: { severity: string }) => item.severity === "blocker").length} блокирующих пунктов`,
                        );
                      })
                    }
                    confirmPlan={(id, planFingerprint) =>
                      setConfirmation({
                        title: "Подтвердить этот план?",
                        text: "Подтверждение действует 10 минут и относится только к показанному плану. Сейчас ничего не создаётся в Директе и деньги не списываются.",
                        action: () =>
                          perform(async () => {
                            await api(
                              `/businesses/${ws.id}/direct/${id}/confirm`,
                              { planFingerprint },
                            );
                            await load(ws.id);
                            setToast(
                              "План подтверждён локально. Запись в Директ остаётся выключенной.",
                            );
                          }),
                      })
                    }
                    executePlan={(id, planFingerprint, name, budget) =>
                      setConfirmation({
                        title: `Создать выключенную кампанию «${name}»?`,
                        text: `Директ создаст кампанию с лимитом ${(
                          budget / 100
                        ).toLocaleString(
                          "ru-RU",
                        )} ₽, сразу остановит её и только затем добавит объявления. Если ответ API потеряется, повтор будет заблокирован до сверки. Показы не будут включены этим действием.`,
                        action: () =>
                          perform(async () => {
                            try {
                              await api(
                                `/businesses/${ws.id}/direct/${id}/execute`,
                                { planFingerprint },
                              );
                              setToast(
                                "Выключенная кампания создана и сверена",
                              );
                            } finally {
                              await load(ws.id);
                            }
                          }),
                      })
                    }
                    inspectExecution={(id) =>
                      perform(async () => {
                        try {
                          await api(
                            `/businesses/${ws.id}/direct/${id}/execution/inspect`,
                            {},
                          );
                          setToast("Известные объекты проверены в Директе");
                        } finally {
                          await load(ws.id);
                        }
                      })
                    }
                    suspendCampaign={(id, name, campaignId) =>
                      setConfirmation({
                        title: `Проверить остановку «${name}»?`,
                        text: `Проверим кампанию №${campaignId} в Директе. Если показы идут, отправим одну команду остановки и прочитаем состояние повторно. Бюджет при этом не увеличится.`,
                        action: () =>
                          perform(async () => {
                            const keyName = `ritm:suspend:${ws.id}:${id}`;
                            const requestKey =
                              safeStorage.getItem(keyName) ||
                              crypto.randomUUID();
                            safeStorage.setItem(keyName, requestKey);
                            try {
                              const action = await api(
                                `/businesses/${ws.id}/direct/${id}/suspend`,
                                {},
                                "POST",
                                requestKey,
                              );
                              if (
                                action.status === "succeeded" ||
                                action.status === "failed_no_write"
                              )
                                safeStorage.removeItem(keyName);
                              setToast(
                                action.status === "succeeded"
                                  ? "Остановка подтверждена Директом"
                                  : action.status === "failed_no_write"
                                    ? "Предварительная проверка не прошла; команда не отправлялась."
                                    : "Ответ требует сверки; повторная запись заблокирована",
                              );
                            } finally {
                              await load(ws.id);
                            }
                          }),
                      })
                    }
                    inspectLifecycle={(id, actionId) =>
                      perform(async () => {
                        try {
                          const action = await api(
                            `/businesses/${ws.id}/direct/${id}/lifecycle/${actionId}/inspect`,
                            {},
                          );
                          if (action.status === "succeeded")
                            safeStorage.removeItem(
                              `ritm:suspend:${ws.id}:${id}`,
                            );
                          setToast(
                            action.status === "succeeded"
                              ? "Остановка подтверждена Директом"
                              : "Состояние ещё требует ручной проверки",
                          );
                        } finally {
                          await load(ws.id);
                        }
                      })
                    }
                    checkBudget={(id) =>
                      perform(async () => {
                        try {
                          const result = await api(
                            `/businesses/${ws.id}/direct/${id}/budget-check`,
                            {},
                          );
                          setToast(
                            result.status === "matched"
                              ? "Лимит и даты сверены с Директом"
                              : "Настройки в Директе отличаются от плана",
                          );
                        } finally {
                          await load(ws.id);
                        }
                      })
                    }
                    inspectControl={(id) =>
                      performWithResult(async () => {
                        try {
                          const result = await api(
                            `/businesses/${ws.id}/direct/${id}/control-review`,
                            {},
                            "POST",
                            crypto.randomUUID(),
                          );
                          const waitingForYandex = result.blockers?.some(
                            (code: string) =>
                              [
                                "campaign_under_review",
                                "ads_under_review",
                              ].includes(code),
                          );
                          setToast(
                            waitingForYandex
                              ? "Яндекс ещё проверяет объявление. Показы не запущены"
                              : result.status === "technical_ready"
                                ? "Техническая проверка пройдена; для запуска нужны отдельные согласования"
                                : "Яндекс пока не разрешил показы — причина указана ниже",
                          );
                        } finally {
                          await load(ws.id);
                        }
                      })
                    }
                    reviewShadow={(id) =>
                      perform(async () => {
                        try {
                          const result = await api(
                            `/businesses/${ws.id}/direct/${id}/shadow-review`,
                            {},
                            "POST",
                            crypto.randomUUID(),
                          );
                          setToast(
                            result.status === "observed"
                              ? "Сводка Директа и Метрики обновлена"
                              : "Для сводки пока недостаточно данных",
                          );
                        } finally {
                          await load(ws.id);
                        }
                      })
                    }
                    refresh={() => load(ws.id)}
                  />
                </>
              )}
              {page === "experiments" && (
                <Experiments
                  ws={ws}
                  busy={busy}
                  navigate={select}
                  tick={() => perform(() => cmd("tick"))}
                  createAbPlan={(changeId, input) =>
                    perform(async () => {
                      await api(
                        `/businesses/${ws.id}/direct/${changeId}/ab-plan`,
                        input,
                      );
                      await load(ws.id);
                      setToast(
                        "A/B-гипотеза сохранена. В Директе ничего не изменилось.",
                      );
                    })
                  }
                  createAudienceExperiment={(changeId, input) =>
                    perform(async () => {
                      await api(
                        `/businesses/${ws.id}/direct/${changeId}/audience-experiment`,
                        input,
                      );
                      await load(ws.id);
                      setToast(
                        "Тест аудитории зафиксирован. Публикации и запуска показов не было.",
                      );
                    })
                  }
                  createAbVariant={(plan) =>
                    setConfirmation({
                      title: `Создать вариант Б в кампании №${plan.campaignId}?`,
                      text: `Будет создано одно объявление в той же выключенной группе: «${plan.variant.title}». Кампания не отправится на модерацию и показы не включатся.`,
                      action: () =>
                        perform(async () => {
                          const keyName = `ritm:ab-variant:${ws.id}:${plan.id}`;
                          const requestKey =
                            safeStorage.getItem(keyName) || crypto.randomUUID();
                          safeStorage.setItem(keyName, requestKey);
                          try {
                            const action = await api(
                              `/businesses/${ws.id}/direct/${plan.changeId}/ab-variant`,
                              {
                                confirmCampaignId: plan.campaignId,
                                confirmControlAdId: plan.control.adId,
                                variantConfirmed: true,
                              },
                              "POST",
                              requestKey,
                            );
                            if (
                              [
                                "succeeded",
                                "failed_no_write",
                                "not_applied",
                              ].includes(action.status)
                            )
                              safeStorage.removeItem(keyName);
                            setToast(
                              action.status === "succeeded"
                                ? "Вариант Б создан и подтверждён. Показы не включались."
                                : action.status === "needs_reconciliation"
                                  ? "Ответ Директа требует сверки; повтор заблокирован."
                                  : "Объявление не создавалось.",
                            );
                          } finally {
                            await load(ws.id);
                          }
                        }),
                    })
                  }
                  inspectAbVariant={(plan) =>
                    perform(async () => {
                      try {
                        const action = await api(
                          `/businesses/${ws.id}/direct/${plan.changeId}/ab-variant/${plan.action!.id}/inspect`,
                          {},
                        );
                        if (action.status !== "needs_reconciliation")
                          safeStorage.removeItem(
                            `ritm:ab-variant:${ws.id}:${plan.id}`,
                          );
                        setToast(
                          action.status === "succeeded"
                            ? "Вариант Б найден и подтверждён."
                            : "Вариант Б не найден; повтор возможен только новым действием.",
                        );
                      } finally {
                        await load(ws.id);
                      }
                    })
                  }
                  syncAbReport={(plan) =>
                    perform(async () => {
                      const result = await api(
                        `/businesses/${ws.id}/direct/ab-plans/${plan.id}/report`,
                        {},
                      );
                      await load(ws.id);
                      setToast(result.message);
                    })
                  }
                  decideAb={(plan, operation, targetAdId) =>
                    setConfirmation({
                      title:
                        operation === "rollback_variant"
                          ? `Удалить черновик Б №${targetAdId}?`
                          : `Остановить проигравшее объявление №${targetAdId}?`,
                      text:
                        operation === "rollback_variant"
                          ? "Будет удалён только выключенный черновик варианта Б. Контрольное объявление и кампания не изменятся."
                          : "Показы проигравшего объявления будут остановлены. Победившее объявление и лимит кампании не изменятся.",
                      action: () =>
                        perform(async () => {
                          const keyName = `ritm:ab-decision:${ws.id}:${plan.id}`,
                            requestKey =
                              safeStorage.getItem(keyName) ||
                              crypto.randomUUID();
                          safeStorage.setItem(keyName, requestKey);
                          try {
                            const action = await api(
                              `/businesses/${ws.id}/direct/ab-plans/${plan.id}/decision`,
                              {
                                operation,
                                confirmCampaignId: plan.campaignId,
                                confirmTargetAdId: targetAdId,
                                confirmed: true,
                              },
                              "POST",
                              requestKey,
                            );
                            if (action.status !== "needs_reconciliation")
                              safeStorage.removeItem(keyName);
                            setToast(
                              action.status === "succeeded"
                                ? operation === "rollback_variant"
                                  ? "Черновик варианта Б удалён и проверен."
                                  : "Проигравшее объявление остановлено и проверено."
                                : action.status === "needs_reconciliation"
                                  ? "Результат требует сверки; повторная запись заблокирована."
                                  : "Действие не отправлялось в Директ.",
                            );
                          } finally {
                            await load(ws.id);
                          }
                        }),
                    })
                  }
                  inspectAbDecision={(plan) =>
                    perform(async () => {
                      try {
                        const action = await api(
                          `/businesses/${ws.id}/direct/ab-plans/${plan.id}/decisions/${plan.decision!.id}/inspect`,
                          {},
                        );
                        if (action.status !== "needs_reconciliation")
                          safeStorage.removeItem(
                            `ritm:ab-decision:${ws.id}:${plan.id}`,
                          );
                        setToast(
                          action.status === "succeeded"
                            ? "A/B-действие подтверждено чтением Директа."
                            : "Изменение не найдено; повтор возможен только новым действием.",
                        );
                      } finally {
                        await load(ws.id);
                      }
                    })
                  }
                />
              )}
              {page === "creatives" && (
                <Creatives
                  ws={ws}
                  busy={busy}
                  navigate={select}
                  approve={(id) =>
                    performWithResult(() => cmd("approve", { id }))
                  }
                  generateImage={(input) =>
                    perform(async () => {
                      await api(`/businesses/${ws.id}/creative-images`, input);
                      await load(ws.id);
                      setToast("Изображение поставлено в очередь");
                    })
                  }
                  connectKie={(apiKey) =>
                    perform(async () => {
                      await api(
                        `/businesses/${ws.id}/image-provider/kie`,
                        { apiKey },
                        "PUT",
                      );
                      await load(ws.id);
                      setToast("Генерация Kie.ai подключена");
                    })
                  }
                  disconnectKie={() =>
                    setConfirmation({
                      title: "Отключить генерацию Kie.ai?",
                      text: "Ключ удалится с этого сервера. Новые варианты больше не будут создаваться, а уже сохранённые останутся на проверке.",
                      actionLabel: "Отключить",
                      intent: "danger",
                      action: () =>
                        perform(async () => {
                          await api(
                            `/businesses/${ws.id}/image-provider/kie`,
                            {},
                            "DELETE",
                          );
                          await load(ws.id);
                          setToast("Генерация Kie.ai отключена");
                        }),
                    })
                  }
                  approveImage={(id) =>
                    setConfirmation({
                      title: "Согласовать изображение?",
                      text: "Подтвердите, что в кадре нет лишних пальцев, искажённых лиц, парящих предметов и случайного текста, а услуга и название компании читаются верно. Автоматической публикации не произойдет.",
                      action: () =>
                        perform(async () => {
                          await api(
                            `/businesses/${ws.id}/creative-images/${id}/approve`,
                            {},
                          );
                          await load(ws.id);
                          setToast("Изображение согласовано");
                        }),
                    })
                  }
                  uploadImage={(id, login) =>
                    setConfirmation({
                      title: "Добавить изображение в Директ?",
                      text: `Ритм добавит согласованный файл в библиотеку кабинета ${login}. Объявления и показы не запустятся.`,
                      actionLabel: "Добавить в Директ",
                      action: () =>
                        perform(async () => {
                          const storageKey = `ritm:direct-image:${ws.id}:${id}:${login}`;
                          const requestKey =
                            safeStorage.getItem(storageKey) ||
                            crypto.randomUUID();
                          safeStorage.setItem(storageKey, requestKey);
                          const result = await api(
                            `/businesses/${ws.id}/creative-images/${id}/direct-upload`,
                            { login, uploadConfirmed: true },
                            "POST",
                            requestKey,
                          );
                          if (result.status === "succeeded")
                            safeStorage.removeItem(storageKey);
                          await load(ws.id);
                          setToast(
                            "Изображение добавлено в Директ. Показы не запущены.",
                          );
                        }),
                    })
                  }
                  inspectImage={(id, login) =>
                    perform(async () => {
                      const storageKey = `ritm:direct-image:${ws.id}:${id}:${login}`;
                      const requestKey = safeStorage.getItem(storageKey);
                      if (!requestKey)
                        throw new Error(
                          "Нет незавершённой загрузки для сверки.",
                        );
                      const result = await api(
                        `/businesses/${ws.id}/creative-images/${id}/direct-upload/${requestKey}/inspect`,
                        { login },
                      );
                      if (result.status === "succeeded") {
                        safeStorage.removeItem(storageKey);
                        setToast(
                          "Изображение найдено и подтверждено в Директе.",
                        );
                      } else {
                        setToast(
                          "Изображение пока не найдено. Повторная отправка заблокирована.",
                        );
                      }
                      await load(ws.id);
                    })
                  }
                  removeImage={(id) =>
                    setConfirmation({
                      title: "Удалить этот визуал?",
                      text: "Файл и история генерации этого несогласованного варианта будут удалены без возможности восстановления.",
                      actionLabel: "Удалить визуал",
                      intent: "danger",
                      action: () =>
                        perform(async () => {
                          await api(
                            `/businesses/${ws.id}/creative-images/${id}`,
                            {},
                            "DELETE",
                          );
                          await load(ws.id);
                          setToast("Несогласованный визуал удалён");
                        }),
                    })
                  }
                  refresh={() => load(ws.id)}
                />
              )}
              {page === "history" && (
                <HistoryView
                  ws={ws}
                  busy={busy}
                  undo={(e) =>
                    setConfirmation({
                      title: "Отменить это изменение?",
                      text: `«${e.title}». Сначала проверим, что после него не было конфликтующих изменений. Уже потраченные деньги не возвращаются.`,
                      action: () => cmd("rollback", { id: e.id }),
                    })
                  }
                  rollbackOptimizer={(action) =>
                    setConfirmation({
                      title: "Снова разрешить показы?",
                      text: "Защитная остановка будет отменена только после повторной проверки кампании, рекламодателя, маркировки и прежнего лимита. После подтверждения расходы могут возобновиться.",
                      actionLabel: "Проверить и возобновить",
                      action: () =>
                        perform(async () => {
                          const result = await api(
                            `/businesses/${ws.id}/optimizer-actions/${action.id}/rollback`,
                            { spendConfirmed: true },
                          );
                          await load(ws.id);
                          setToast(
                            result.status === "rolled_back"
                              ? "Защитная остановка отменена и подтверждена Direct"
                              : "Откат не подтверждён — повторный запуск заблокирован",
                          );
                        }),
                    })
                  }
                />
              )}
              {page === "advisor" && (
                <Advisor
                  ws={ws}
                  busy={busy}
                  navigate={select}
                  analyze={() =>
                    perform(async () => {
                      const result = await api(
                        `/businesses/${ws.id}/analyze`,
                        {},
                      );
                      await load(ws.id);
                      setToast(result.message);
                    })
                  }
                  schedule={() =>
                    perform(() =>
                      cmd("schedule", { enabled: !ws.state.shadowAnalysis }),
                    )
                  }
                />
              )}
              {page === "reports" && (
                <Reports
                  key={ws.id}
                  ws={ws}
                  busy={busy}
                  navigate={select}
                  refresh={() => perform(() => load(ws.id))}
                  sync={(login, scenario) =>
                    perform(async () => {
                      const result = await api(`/businesses/${ws.id}/reports`, {
                        login,
                        scenario,
                      });
                      await load(ws.id);
                      setToast(result.message);
                    })
                  }
                />
              )}
              {page === "connections" && (
                <Connections
                  key={ws.id}
                  ws={ws}
                  busy={busy}
                  connectDemo={() => perform(() => cmd("analytics"))}
                  refresh={() => perform(() => load(ws.id))}
                  disconnect={() =>
                    setConfirmation({
                      title: "Отключить Яндекс?",
                      text: "Ритм отключит связь с Яндексом и удалит сохранённый доступ. Кампании в Директе останутся без изменений.",
                      action: async () => {
                        const result = await api(
                          `/businesses/${ws.id}/connections/yandex/disconnect`,
                          {},
                        );
                        await load(ws.id);
                        setToast(
                          result.revoked
                            ? "Яндекс отключен, токен отозван"
                            : result.warning,
                        );
                      },
                    })
                  }
                />
              )}
              {page === "settings" && (
                <Settings
                  ws={ws}
                  edit={() => setModal("business-edit")}
                  add={() => setModal("business")}
                />
              )}
            </>
          )}
          <footer className="app-footer">
            <span>
              <span className="small-status" />{" "}
              {s?.lastSync
                ? "Обновлено " + time(s.lastSync, s.timezone)
                : "Ожидаем данные"}
              {s?.mode === "demo" ? " · Тестовые данные" : ""}
            </span>
            <button onClick={() => setModal("help")}>
              <HelpCircle size={14} />
              Есть вопрос?
            </button>
          </footer>
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Мобильная навигация">
        <button
          className={page === "settings" ? "selected" : ""}
          aria-current={page === "settings" ? "page" : undefined}
          onClick={() => select("settings")}
        >
          <SlidersHorizontal size={20} />
          <span>О бизнесе</span>
        </button>
        <button
          className={page === "connections" ? "selected" : ""}
          aria-current={page === "connections" ? "page" : undefined}
          onClick={() => select("connections")}
        >
          <Plug size={20} />
          <span>Страница</span>
        </button>
        <button
          className={page === "campaigns" ? "selected" : ""}
          aria-current={page === "campaigns" ? "page" : undefined}
          onClick={() => select("campaigns")}
        >
          <Megaphone size={20} />
          <span>План и запуск</span>
        </button>
        <button
          className={page === "overview" ? "selected" : ""}
          aria-current={page === "overview" ? "page" : undefined}
          onClick={() => select("overview")}
        >
          <Grid2X2 size={20} />
          <span>Итоги</span>
        </button>
        <button
          className={
            mobileMore ||
            [
              "experiments",
              "creatives",
              "advisor",
              "reports",
              "history",
            ].includes(page)
              ? "selected"
              : ""
          }
          aria-expanded={mobileMore}
          onClick={() => setMobileMore(!mobileMore)}
        >
          <MoreHorizontal size={20} />
          <span>Ещё</span>
        </button>
      </nav>
      {mobileMore && (
        <dialog
          ref={mobileSheetRef}
          className="mobile-sheet-backdrop"
          aria-label="Другие разделы"
          onCancel={(event) => {
            event.preventDefault();
            setMobileMore(false);
          }}
          onClick={(event) => {
            if (event.target === mobileSheetRef.current) setMobileMore(false);
          }}
        >
          <section className="mobile-more-sheet" aria-label="Другие разделы">
            <div className="mobile-sheet-handle" />
            <div className="mobile-sheet-heading">
              <div>
                <b>Рабочее пространство</b>
                <span>{s?.name}</span>
              </div>
              <button aria-label="Закрыть" onClick={() => setMobileMore(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="mobile-sheet-grid">
              {[
                ["experiments", "Эксперименты", Split],
                ["creatives", "Изображения", FileText],
                ["advisor", "Наблюдение Ритма", ChartLine],
                ["reports", "Данные и отчёты", Database],
                ["history", "История", List],
              ].map(([id, label, Icon]) => {
                const SheetIcon = Icon as React.ElementType;
                return (
                  <button
                    key={id as string}
                    onClick={() => select(id as string)}
                  >
                    <SheetIcon size={20} />
                    <span>{label as string}</span>
                  </button>
                );
              })}
              <button type="button" onClick={toggleTheme}>
                {theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
                <span>{theme === "dark" ? "Светлая тема" : "Тёмная тема"}</span>
              </button>
            </div>
            <div className="mobile-account-actions">
              <div>
                <span>Аккаунт</span>
                <b>{session.user.name}</b>
              </div>
              <button type="button" onClick={signOut} disabled={busy}>
                <LogOut size={18} />
                Выйти
              </button>
            </div>
          </section>
        </dialog>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {toast}
        </div>
      )}
      {modal === "budget" && ws && (
        <BudgetModal
          ws={ws}
          busy={busy}
          error={error}
          close={() => setModal(null)}
          save={async (budget) =>
            perform(async () => {
              await cmd("budget", { budget });
              setModal(null);
            })
          }
        />
      )}
      {modal === "business" && (
        <BusinessModal
          busy={busy}
          error={error}
          ownerName={session.user.name}
          close={() => setModal(null)}
          save={(input) =>
            perform(async () => {
              const r = await api("/businesses/with-plan", input);
              await load(r.id);
              setModal(null);
              setPage("connections");
              setToast(
                r.plan.provider === "ollama"
                  ? "Рита подготовила план. Теперь выберите страницу и подключите Директ."
                  : "Профиль собран. Теперь выберите страницу и подключите Директ.",
              );
            })
          }
        />
      )}
      {modal === "business-edit" && ws && (
        <BusinessModal
          busy={busy}
          error={error}
          initial={ws.state}
          ownerName={session.user.name}
          close={() => setModal(null)}
          save={(input) =>
            perform(async () => {
              await cmd("settings", input);
              const generated = await api(`/businesses/${ws.id}/ai-plan`, {});
              await load(ws.id);
              setModal(null);
              setPage("campaigns");
              setToast(
                generated.plan.provider === "ollama"
                  ? "Профиль и рекламный план обновлены"
                  : "Профиль обновлён, план пересобран безопасным сценарием",
              );
            })
          }
        />
      )}
      {modal === "help" && (
        <Modal title="Как работает Ритм" close={() => setModal(null)}>
          <div className="help-content">
            <p>
              Вы описываете бизнес и задаете бюджет. Ритм распределяет его между
              направлениями, отслеживает результаты и объясняет каждое
              изменение.
            </p>
            <h3>Что можно проверить сейчас</h3>
            <p>
              В демо кнопка «Смоделировать день» добавляет тестовый день. Ничего
              не списывается и реклама не уходит в Яндекс. Вы увидите, как
              меняются результаты и как Ритм объясняет свои предложения.
            </p>
            <h3>Как читать показатели</h3>
            <p>
              Обращение — запись или заявка. Клиент — подтвержденный визит или
              покупка. Если подтверждений нет, число клиентов не рассчитывается.
              Стоимость обращения — расход, разделенный на количество обращений.
            </p>
            <h3>Что будет после подключения</h3>
            <p>
              Для реального режима нужны подключение Яндекса и страница, куда
              перейдёт клиент. Если собственного сайта нет, Яндекс может создать
              такую страницу. Пока режим записи выключен, Ритм только проверяет
              план и ничего не меняет в рекламе.
            </p>
            <div className="info-box">
              <ShieldCheck size={20} />
              <span>
                Ритм не предложит потратить больше установленного бюджета.
                Каждое изменение сохраняется в истории, а доступные откаты
                остаются под вашим контролем.
              </span>
            </div>
          </div>
        </Modal>
      )}
      {confirmation && (
        <Modal
          title={confirmation.title}
          error={error}
          close={() => !busy && setConfirmation(null)}
        >
          <p className="modal-copy">{confirmation.text}</p>
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={busy}
              autoFocus
              onClick={() => setConfirmation(null)}
            >
              Отмена
            </button>
            <button
              className={
                confirmation.intent === "danger" ? "danger-button" : "primary"
              }
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await confirmation.action();
                  setConfirmation(null);
                })
              }
            >
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Check size={16} />
              )}
              {confirmation.actionLabel || "Подтвердить"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Reports({
  ws,
  busy,
  navigate,
  refresh,
  sync,
}: {
  ws: Workspace;
  busy: boolean;
  navigate: (page: string) => void;
  refresh: () => Promise<void>;
  sync: (login: string, scenario: string) => void;
}) {
  const amount = (value: number) =>
    new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: "RUB",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value / 100);
  const accounts =
    ws.connections.find((c) => c.provider === "yandex")?.clients || [];
  const [login, setLogin] = useState(accounts[0]?.Login || "");
  const report = ws.reports?.[0];
  const pending = ws.reportJobs?.some((j) =>
    ["pending", "running"].includes(j.status),
  );
  const labels: Record<string, string> = {
    pending: "Ожидает отчёт",
    running: "Запрашиваем отчёт",
    succeeded: "Готово",
    failed: "Нужна проверка",
    cancelled: "Отменено",
  };
  const source = (value: string) =>
    value === "demo"
      ? "Тестовый источник"
      : value === "yandex-sandbox"
        ? "Яндекс · Sandbox"
        : "Яндекс Директ";
  return (
    <section className="advisor-panel">
      <div className="card advisor-item">
        <Badge tone="neutral">Только чтение · Не меняет рекламу</Badge>
        <h2>Отдельный журнал источников</h2>
        <p>
          Ритм показывает расходы и клики из рекламы отдельно от обращений на
          сайте или странице Яндекса. Источники не смешиваются, чтобы обычный
          визит не выдавался за обращение.
        </p>
        {ws.state.mode === "demo" ? (
          <p className="muted">
            В демо формируется тестовый отчёт из текущей симуляции. «Проверить
            расхождение» добавляет 125 ₽ только в тестовый отчёт — бюджет и
            расход симулятора не меняются.
          </p>
        ) : (
          <label>
            Кабинет{" "}
            <select
              aria-label="Кабинет для отчёта"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={a.Login} value={a.Login}>
                  {a.Login} · {a.Currency || "валюта неизвестна"}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="report-actions">
          <button
            className="primary"
            disabled={busy || pending || (ws.state.mode === "live" && !login)}
            onClick={() =>
              sync(ws.state.mode === "demo" ? "" : login, "normal")
            }
          >
            <Download size={16} />{" "}
            {ws.state.mode === "demo"
              ? "Сформировать тестовый отчёт"
              : "Обновить данные из Яндекса"}
          </button>
          {ws.state.mode === "demo" && (
            <>
              <button
                className="secondary"
                disabled={busy || pending || !report}
                onClick={() => sync("", "revised")}
              >
                Проверить расхождение
              </button>
              <button
                className="secondary"
                disabled={busy || pending}
                onClick={() => sync("", "pending")}
              >
                Проверить ожидание
              </button>
            </>
          )}
          <button className="secondary" disabled={busy} onClick={refresh}>
            <RefreshCw size={16} /> Обновить статус
          </button>
        </div>
      </div>
      {!!ws.reportJobs?.length && (
        <div className="card advisor-item">
          <h3>Получение отчётов</h3>
          <ul>
            {ws.reportJobs.map((j) => (
              <li key={j.id}>
                {labels[j.status] || j.status} · запросов: {j.attempts}
                {j.status === "pending" && (
                  <span>
                    {" "}
                    · проверка не раньше{" "}
                    {time(
                      new Date(j.availableAt).toISOString(),
                      ws.state.timezone,
                    )}
                  </span>
                )}
                {j.error && <p className="muted">{j.error}</p>}
              </li>
            ))}
          </ul>
          <p className="muted small">
            Сервер продолжит обработку без открытой вкладки. Нажмите «Обновить
            статус», чтобы увидеть результат.
          </p>
        </div>
      )}
      {!report ? (
        <Empty
          title="Пока нет сохранённых отчётов"
          text="Запросите первый отчёт. Ответ «формируется» не будет превращён в нулевой расход."
          action={
            ws.state.mode === "live" && !accounts.length ? (
              <button
                className="secondary"
                onClick={() => navigate("connections")}
              >
                Проверить подключение <ArrowRight size={16} />
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="card advisor-item">
            <Badge tone={report.empty ? "neutral" : "green"}>
              {source(report.source)}
            </Badge>
            <h2>
              {report.empty
                ? "За выбранный период данных о показах нет"
                : `${report.reportType === "ad" ? "Объявления · " : "Кампании · "}${amount(report.totals.spent)} за ${date(report.dateFrom)} — ${date(report.dateTo)}`}
            </h2>
            <p>
              Кабинет: {report.login} · Получен{" "}
              {time(report.receivedAt, ws.state.timezone)} · {report.currency} ·
              НДС включён · {report.totals.rowCount} строк ·{" "}
              {count(report.totals.clicks)} кликов
            </p>
            {(report.metrica || ws.state.landingMode === "yandex_landing") && (
              <div className="report-source-grid">
                <div>
                  <span>Яндекс Директ</span>
                  <b>
                    {report.empty ? "Нет строк" : amount(report.totals.spent)}
                  </b>
                  <small>
                    {count(report.totals.clicks)} кликов ·{" "}
                    {count(report.totals.impressions)} показов
                  </small>
                </div>
                <div>
                  <span>
                    {ws.state.landingMode === "yandex_landing"
                      ? "Страница Яндекса"
                      : "Яндекс Метрика"}
                  </span>
                  {ws.state.landingMode === "yandex_landing" ? (
                    <>
                      <b>{count(report.totals.conversions ?? 0)} обращений</b>
                      <small>Конверсии из отчёта Директа</small>
                    </>
                  ) : report.metrica?.status === "ready" ? (
                    <>
                      <b>{count(report.metrica?.visits ?? 0)} визитов</b>
                      <small>
                        {count(report.metrica?.goalReaches ?? 0)} достижений
                        цели
                      </small>
                    </>
                  ) : (
                    <>
                      <b>Временно недоступна</b>
                      <small>Отчёт Директа сохранён отдельно</small>
                    </>
                  )}
                </div>
              </div>
            )}
            {report.empty ? (
              <div className="info-note report-empty-note">
                <ShieldCheck size={18} />
                <div>
                  <b>Отчёт получен корректно</b>
                  <p>
                    Яндекс вернул готовый файл без строк. Выключенные черновики
                    не создают показов, кликов и расходов, поэтому нулевые
                    показатели здесь не считаются статистикой кампании.
                    {report.metrica?.status === "ready" &&
                      " Визиты Метрики показаны отдельно и пока не относятся к этим рекламным черновикам."}
                  </p>
                </div>
              </div>
            ) : report.comparison.status === "first" ? (
              <p>
                Первый снимок этого кабинета и периода. Сравнивать пока не с
                чем.
              </p>
            ) : (
              <div className="info-note">
                <b>
                  {report.comparison.status === "changed"
                    ? "Обнаружены изменения"
                    : "Показатели совпадают"}
                </b>
                <p>
                  Разница расхода: {amount(report.comparison.deltaSpent)}.
                  Изменено строк: {report.comparison.changedRows}; добавлено:{" "}
                  {report.comparison.addedRows}; отсутствует:{" "}
                  {report.comparison.missingRows}.
                </p>
                <p>
                  Консервативная оценка по максимумам каждой строки двух
                  снимков: {amount(report.comparison.conservativeSpent)}. Это
                  сигнал для сверки, не подтверждённый расход и не установленный
                  лимит площадки.
                </p>
              </div>
            )}
            <a
              className="button secondary"
              href={`/api/businesses/${ws.id}/reports/${report.id}/xlsx`}
            >
              <Download size={16} /> Скачать Excel
            </a>
            <a
              className="button secondary"
              href={`/api/businesses/${ws.id}/reports/${report.id}/raw`}
            >
              Скачать исходник в JSON
            </a>
            <details>
              <summary>Контрольная сумма источника</summary>
              <code className="report-hash">SHA-256: {report.rawHash}</code>
            </details>
          </div>
          <div className="card advisor-item">
            <h3>
              {report.empty
                ? "Состав последнего ответа"
                : "Строки последнего снимка"}
            </h3>
            {report.empty ? (
              <p className="muted">
                Строк с кампаниями нет. Сервис не добавляет искусственные нули и
                не смешивает этот ответ с данными Метрики.
              </p>
            ) : (
              <div className="report-table">
                <table>
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>
                        {report.reportType === "ad" ? "Объявление" : "Кампания"}
                      </th>
                      <th>Расход</th>
                      <th>Клики</th>
                      <th>Показы</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r) => (
                      <tr
                        key={r.Date + ":" + r.CampaignId + ":" + (r.AdId || "")}
                      >
                        <td data-label="Дата">{r.Date}</td>
                        <td
                          data-label={
                            report.reportType === "ad"
                              ? "Объявление"
                              : "Кампания"
                          }
                        >
                          {report.reportType === "ad"
                            ? `Объявление ${r.AdId}`
                            : r.CampaignName || r.CampaignId}
                          <small className="muted">
                            {report.reportType === "ad"
                              ? ` · кампания ${r.CampaignId}`
                              : ` · ID ${r.CampaignId}`}
                          </small>
                        </td>
                        <td data-label="Расход">{amount(r.spent)}</td>
                        <td data-label="Клики">{count(r.clicks)}</td>
                        <td data-label="Показы">{count(r.impressions)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {report.totals.rowCount > 100 && (
              <p>Показаны первые 100 строк; полный источник доступен выше.</p>
            )}
          </div>
          <div className="card advisor-item">
            <h3>Последние обновления</h3>
            <ul>
              {ws.reports.map((r) => (
                <li key={r.id}>
                  {time(r.receivedAt, ws.state.timezone)} · {source(r.source)} ·{" "}
                  {r.reportType === "ad" ? "объявления" : "кампании"} ·{" "}
                  {r.login} · {r.dateFrom} — {r.dateTo} ·{" "}
                  {r.empty ? "нет данных" : amount(r.totals.spent)}{" "}
                  <a href={`/api/businesses/${ws.id}/reports/${r.id}/raw`}>
                    Исходник
                  </a>{" "}
                  <a href={`/api/businesses/${ws.id}/reports/${r.id}/xlsx`}>
                    Excel
                  </a>
                </li>
              ))}
            </ul>
            <p className="muted small">
              Ритм сравнивает данные только за одинаковые периоды и из одного
              источника, чтобы не делать выводы по несопоставимым цифрам.
            </p>
          </div>
        </>
      )}
    </section>
  );
}

function Advisor({
  ws,
  busy,
  navigate,
  analyze,
  schedule,
}: {
  ws: Workspace;
  busy: boolean;
  navigate: (page: string) => void;
  analyze: () => void;
  schedule: () => void;
}) {
  const report = ws.state.analysis;
  const jobStatus: Record<string, string> = {
    pending: "Ожидает выполнения",
    running: "Выполняется",
    succeeded: "Завершено",
    cancelled: "Отменено — данные изменились",
    failed: "Требует внимания",
  };
  const actions: Record<string, string> = {
    observe: "Наблюдать",
    review_pause: "Рассмотреть остановку",
    test_message: "Проверить другую подачу",
    consider_scale: "Рассмотреть перераспределение",
  };
  return (
    <section className="advisor-panel">
      <div className="card advisor-intro">
        <div>
          <Badge tone={ws.state.shadowAnalysis ? "green" : "neutral"}>
            {ws.state.shadowAnalysis ? "Ритм наблюдает" : "Наблюдение на паузе"}
          </Badge>
          <h2>Ритм следит за результатом и подсказывает следующий шаг</h2>
          <p>
            Пока этот режим собирает данные и объясняет, что происходит. Он не
            запускает показы, не меняет рекламу и не увеличивает бюджет.
          </p>
        </div>
        <button
          className="secondary"
          disabled={
            busy || !ws.capabilities.analyst || ws.state.mode !== "demo"
          }
          onClick={schedule}
        >
          {ws.state.shadowAnalysis
            ? "Остановить наблюдение"
            : "Включить наблюдение"}
        </button>
      </div>
      <div className="advisor-intro card">
        <div>
          <Badge tone="neutral">Что делает Рита</Badge>
          <h2>Находит изменения и объясняет их простыми словами</h2>
          <p>
            Рита может предложить новый текст или подсказать, что проверить.
            Любое изменение рекламы остаётся видимым для вас, а общий бюджет без
            вашего решения не увеличивается.
          </p>
        </div>
        <button
          className="primary"
          disabled={
            busy || !ws.capabilities.analyst || !ws.state.campaigns.length
          }
          onClick={analyze}
        >
          {busy ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <ChartLine size={17} />
          )}{" "}
          {busy ? "Проверяем данные…" : "Проверить сейчас"}
        </button>
      </div>
      {!ws.capabilities.analyst && (
        <div className="info-note">
          Наблюдение пока недоступно. Проверьте настройки сервиса или обратитесь
          к тому, кто его устанавливал.
        </div>
      )}
      {!ws.state.campaigns.length && (
        <Empty
          title="Пока нечего анализировать"
          text={
            ws.state.mode === "demo"
              ? "Создайте тестовый план и соберите статистику направлений."
              : "Создайте кампанию и получите подтверждённые данные, чтобы анализ опирался на факты."
          }
          action={
            <button className="secondary" onClick={() => navigate("campaigns")}>
              Подготовить запуск <ArrowRight size={16} />
            </button>
          }
        />
      )}
      {!!ws.jobs?.length && (
        <section className="card advisor-item">
          <h3>Последние проверки</h3>
          <ul>
            {ws.jobs.map((job) => (
              <li key={job.id}>
                {jobStatus[job.status] || job.status}
                {job.error && <p className="muted">{job.error}</p>}
              </li>
            ))}
          </ul>
          <p className="muted small">
            Если проверка не завершилась, Ритм не меняет рекламу и сообщит, что
            нужно перепроверить.
          </p>
        </section>
      )}
      {report && (
        <>
          <div className="advisor-meta">
            <Badge>
              {report.provider === "rules"
                ? "Правила · без LLM"
                : "Локальная LLM"}
            </Badge>
            <span>
              {time(report.createdAt, ws.state.timezone)} · {report.version}
            </span>
          </div>
          {report.stateVersion !== ws.version && (
            <div className="info-note" role="status">
              После анализа данные изменились. Обновите рекомендации перед
              принятием решений.
            </div>
          )}
          <div className="advisor-grid">
            {report.proposals.map((p) => (
              <article className="card advisor-item" key={p.campaignId}>
                <span className="eyebrow">{actions[p.action] || p.action}</span>
                <h3>
                  {ws.state.campaigns.find((c) => c.id === p.campaignId)
                    ?.name || "Направление"}
                </h3>
                <p>{p.summary}</p>
                <dl>
                  <div>
                    <dt>Расход</dt>
                    <dd>{money(p.evidence.spent)}</dd>
                  </div>
                  <div>
                    <dt>Обращения</dt>
                    <dd>{count(p.evidence.leads)}</dd>
                  </div>
                  <div>
                    <dt>Клики</dt>
                    <dd>{count(p.evidence.clicks)}</dd>
                  </div>
                  <div>
                    <dt>Цель за обращение</dt>
                    <dd>{money(p.evidence.targetCpa)}</dd>
                  </div>
                </dl>
                <small className="muted">
                  Ритм сначала сверит данные и лимит. Неоднозначные результаты
                  никогда не повторяются автоматически.
                </small>
              </article>
            ))}
          </div>
          <p className="muted small">
            Проверяются структура ответа, идентификаторы и допустимость действия
            по метрикам. Это не гарантирует достоверность свободного текста LLM
            или будущую эффективность рекламы.
          </p>
        </>
      )}
    </section>
  );
}

function LiveOverview({
  ws,
  select,
}: {
  ws: Workspace;
  select: (page: string) => void;
}) {
  const yandex = ws.connections.find(
    (connection) => connection.provider === "yandex",
  );
  const accountReady =
    yandex?.validation === "verified" && !!yandex.clients.length;
  const hasDestination = Boolean(ws.state.website);
  const usesYandexLanding = ws.state.landingMode === "yandex_landing";
  const analyticsReady = usesYandexLanding
    ? hasDestination
    : !!ws.state.counterId && !!ws.state.goalId;
  const created = ws.directChanges.filter(
    (change) => change.execution?.status === "succeeded",
  );
  const campaignForm = new Intl.PluralRules("ru-RU").select(created.length);
  const lastPlan = ws.directChanges[0];
  const report = ws.reports.find((item) => item.source === "yandex");
  const nextPage =
    !accountReady || !analyticsReady ? "connections" : "campaigns";
  const nextLabel = !accountReady
    ? "Подключить страницу и Директ"
    : !analyticsReady
      ? hasDestination
        ? "Выбрать, что считать обращением"
        : "Выбрать, куда вести клиентов"
      : "Проверить и подготовить запуск";
  const growthStages = [
    {
      label: "Бизнес",
      description: "Рита поняла, чем вы занимаетесь",
      done: Boolean(ws.state.service),
      page: "settings",
    },
    {
      label: "Страница и Директ",
      description: "Подключаем место, где найдут вас",
      done: accountReady && hasDestination,
      page: "connections",
    },
    {
      label: "Обращение",
      description: "Выбрали, что считать результатом",
      done: analyticsReady,
      page: "connections",
    },
    {
      label: "План",
      description: "Ритм подготовил рекламу",
      done: Boolean(lastPlan || created.length),
      page: "campaigns",
    },
    {
      label: "Итоги",
      description: "Смотрим понятный результат",
      done: Boolean(report),
      page: "reports",
    },
  ];
  const completedGrowthStages = growthStages.filter(
    (stage) => stage.done,
  ).length;
  const nextGrowthStage = growthStages.find((stage) => !stage.done);
  return (
    <div className="live-overview">
      <section className="live-overview-hero">
        <div>
          <span className="eyebrow">ВАШ МАРШРУТ</span>
          <h2>От рассказа о бизнесе — к понятным итогам рекламы.</h2>
          <p>
            Расскажите о бизнесе, выберите страницу для клиентов и подключите
            Директ. До отдельного подтверждения показы не начнутся.
          </p>
          <button
            type="button"
            className="primary"
            onClick={() => select(nextPage)}
          >
            {nextLabel} <ArrowRight size={17} />
          </button>
        </div>
        <div
          className="live-overview-summary"
          aria-label="Состояние рабочего кабинета"
        >
          <span>Сейчас в кабинете</span>
          <strong>{created.length}</strong>
          <p>
            {campaignForm === "one"
              ? "сверенная кампания"
              : campaignForm === "few"
                ? "сверенные кампании"
                : "сверенных кампаний"}
          </p>
          <small>Подготовленный план ещё не запускает показы.</small>
        </div>
      </section>
      <section className="live-overview-steps" aria-label="Подготовка рекламы">
        <article className="card live-step">
          <span className="live-step-index">01 / СТРАНИЦА И ДИРЕКТ</span>
          <h3>
            {!hasDestination
              ? "Выберите страницу для клиентов"
              : accountReady
                ? "Директ подключён"
                : yandex?.validation === "reauth_required"
                  ? "Подключите Директ повторно"
                  : yandex?.validation === "verified"
                    ? "Кабинет не найден"
                    : yandex
                      ? "Проверяем подключение"
                      : hasDestination
                        ? "Подключите Директ"
                        : "Выберите страницу для клиентов"}
          </h3>
          <p>
            {!hasDestination
              ? "Собственного сайта не требуется. Яндекс может бесплатно создать страницу с вашими контактами."
              : accountReady
                ? `${yandex?.clients.length || 0} доступных кабинетов. Выберите нужный при подготовке кампании.`
                : yandex?.validation === "reauth_required"
                  ? "Доступ к Яндексу истёк. Подключите аккаунт снова, чтобы продолжить."
                  : yandex?.validation === "verified"
                    ? "Подключение есть, но доступных рекламных кабинетов пока нет."
                    : yandex
                      ? "Подключение сохранено. Дождитесь проверки доступа к кабинетам."
                      : "Подключите рекламный кабинет, чтобы Ритм проверил будущий запуск."}
          </p>
          <button
            type="button"
            className="text-button"
            onClick={() => select("connections")}
          >
            {accountReady ? "Проверить подключение" : "Перейти к подключению"}{" "}
            <ArrowRight size={15} />
          </button>
        </article>
        <article className="card live-step">
          <span className="live-step-index">02 / ОБРАЩЕНИЯ</span>
          <h3>
            {usesYandexLanding && analyticsReady
              ? "Страница Яндекса сохранена"
              : !hasDestination
                ? "Сначала выберите страницу"
                : analyticsReady
                  ? "Обращение выбрано"
                  : "Что считать обращением?"}
          </h3>
          <p>
            {usesYandexLanding && analyticsReady
              ? "Код ставить не нужно. Контактные действия на этой странице считает Яндекс."
              : !hasDestination
                ? "После выбора страницы Ритм покажет следующий шаг без лишних настроек."
                : analyticsReady
                  ? "Ритм будет считать выбранное действие на сайте: так вы увидите, сколько людей действительно обращается."
                  : "Выберите действие на сайте: отправка формы, звонок или запись. Ритм подскажет, как его проверить."}
          </p>
          <button
            type="button"
            className="text-button"
            onClick={() => select("connections")}
          >
            {analyticsReady ? "Проверить настройку" : "Выбрать обращение"}{" "}
            <ArrowRight size={15} />
          </button>
        </article>
        <article className="card live-step">
          <span className="live-step-index">03 / ПРОВЕРКА И ЗАПУСК</span>
          <h3>
            {created.length
              ? "Есть сверенная кампания"
              : lastPlan
                ? "План подготовлен"
                : "Подготовьте запуск"}
          </h3>
          <p>
            {created.length
              ? "Проверьте понятный итог: расход, обращения и цену обращения."
              : lastPlan
                ? "Ритм нашёл план. Проверьте препятствия и подготовьте запуск одним действием."
                : "Ритм проверит страницу, обращение, рекламодателя и бюджет перед запуском."}
          </p>
          <button
            type="button"
            className="text-button"
            onClick={() => select("campaigns")}
          >
            Проверить и подготовить запуск <ArrowRight size={15} />
          </button>
        </article>
      </section>
      <section className="card live-growth" aria-labelledby="live-growth-title">
        <header>
          <div>
            <span className="eyebrow">ВАШ ПРОГРЕСС</span>
            <h2 id="live-growth-title">Дерево рекламы</h2>
            <p>
              Оно растёт вместе с подготовкой: не из-за расходов, а когда вы
              закрываете следующий понятный шаг.
            </p>
          </div>
          <div
            className="dispatcher-growth-score"
            aria-label={`Готово ${completedGrowthStages} из ${growthStages.length} этапов`}
          >
            <b>{completedGrowthStages}</b>
            <span>
              из {growthStages.length}
              <small>этапов</small>
            </span>
          </div>
        </header>
        <ol
          className="dispatcher-growth-map"
          aria-label="Этапы запуска рекламы"
        >
          {growthStages.map((stage, index) => (
            <li
              className={
                stage.done
                  ? "done"
                  : stage === nextGrowthStage
                    ? "current"
                    : "pending"
              }
              key={stage.label}
            >
              <span className="dispatcher-growth-tree" aria-hidden="true">
                <img src={rhythmGrowthImages[index]} alt="" />
              </span>
              <span className="dispatcher-growth-copy">
                <b>
                  <em>{index + 1}</em>
                  {stage.label}
                </b>
                <small>{stage.description}</small>
              </span>
              <span className="dispatcher-growth-status">
                {stage.done ? (
                  <>
                    <Check size={12} aria-hidden="true" /> Готово
                  </>
                ) : stage === nextGrowthStage ? (
                  "Следующий шаг"
                ) : (
                  "Дальше"
                )}
              </span>
            </li>
          ))}
        </ol>
        <footer className="dispatcher-growth-footer">
          <span>
            {nextGrowthStage
              ? `Следующий шаг — «${nextGrowthStage.label}». Ритм подскажет, что сделать.`
              : "Всё готово. Ритм продолжит показывать понятные итоги."}
          </span>
          <button
            type="button"
            onClick={() => select(nextGrowthStage?.page || "reports")}
          >
            {nextGrowthStage ? "Продолжить" : "Открыть итоги"}
            <ArrowRight size={14} />
          </button>
        </footer>
      </section>
      <section className="card live-overview-source">
        <div>
          <span className="eyebrow">ИСТОЧНИК ДАННЫХ</span>
          <h2>
            {report
              ? "Последний отчёт Директа сохранён"
              : "Отчёт Директа ещё не получен"}
          </h2>
          <p>
            {report
              ? `Период ${report.dateFrom} — ${report.dateTo}. Проверьте источник и время получения перед выводами.`
              : "После начала периода запросите отчёт. Пока данных о расходе и эффективности этой кампании нет."}
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() => select("reports")}
        >
          Открыть отчёты <ArrowRight size={16} />
        </button>
      </section>
    </div>
  );
}

function Overview({
  ws,
  busy,
  select,
  budget,
  tick,
  pause,
}: {
  ws: Workspace;
  busy: boolean;
  select: (s: string) => void;
  budget: () => void;
  tick: () => void;
  pause: () => void;
}) {
  const { state: s, totals: t } = ws;
  const [inquiryFilter, setInquiryFilter] = useState<
    "all" | "new" | "contacted" | "booked"
  >("all");
  const [chartMode, setChartMode] = useState<"line" | "bars">("line");
  const inquiries = [
    {
      id: "demo-inquiry-1",
      initials: "АК",
      name: "Анна К.",
      source: "Поиск · сегодня, 10:42",
      message: `Хочу записаться на ${s.service || "услугу"} в четверг после 18:00`,
      status: "new" as const,
      statusLabel: "Новая",
    },
    {
      id: "demo-inquiry-2",
      initials: "МС",
      name: "Мария С.",
      source: "Рекламная сеть · сегодня, 09:18",
      message: `Подскажите, пожалуйста, стоимость и свободное время`,
      status: "contacted" as const,
      statusLabel: "Ответили",
    },
    {
      id: "demo-inquiry-3",
      initials: "ОЛ",
      name: "Ольга Л.",
      source: "Поиск · вчера, 19:06",
      message: `Можно записаться на выходные? Я нахожусь рядом`,
      status: "booked" as const,
      statusLabel: "Записана",
    },
    {
      id: "demo-inquiry-4",
      initials: "ЕК",
      name: "Елена К.",
      source: "Рекламная сеть · вчера, 16:31",
      message: `Ищу ${s.category || "студию"} рядом, расскажите об услуге`,
      status: "contacted" as const,
      statusLabel: "Ответили",
    },
    {
      id: "demo-inquiry-5",
      initials: "ДП",
      name: "Дарья П.",
      source: "Поиск · 29 октября, 14:20",
      message: `Есть ли свободное окно на следующей неделе?`,
      status: "booked" as const,
      statusLabel: "Записана",
    },
  ];
  const visibleInquiries = inquiries.filter(
    (inquiry) => inquiryFilter === "all" || inquiry.status === inquiryFilter,
  );
  const spendProgress = s.budget ? Math.min(1, t.spent / s.budget) : 0;
  const averageLeads = s.daily.length ? t.leads / s.daily.length : 0;
  const hasBusiness = !!s.service;
  const hasPlan = hasBusiness && (!!s.aiPlan || s.campaigns.length > 0);
  const hasPreparation = hasPlan && s.campaigns.length > 0;
  const hasAds = hasPreparation && s.running;
  const rhythmStages = [
    {
      label: "Бизнес",
      description: "Расскажите, чем занимаетесь",
      done: hasBusiness,
    },
    { label: "План", description: "Цели, аудитории и бюджет", done: hasPlan },
    {
      label: "Подготовка",
      description: "Направления и объявления",
      done: hasPreparation,
    },
    {
      label: "Реклама",
      description: "Показы и первые обращения",
      done: hasAds,
    },
    {
      label: "Результат",
      description: "Понимаем, что работает",
      done: hasAds && t.leads > 0,
    },
  ];
  const rhythmReady = rhythmStages.filter((stage) => stage.done).length;
  const nextRhythmStage = rhythmStages.find((stage) => !stage.done);
  return (
    <div className="dispatcher-dashboard">
      <section
        className="dispatcher-performance"
        aria-labelledby="performance-title"
      >
        <div className="dispatcher-performance-copy">
          <div className="dispatcher-kicker">
            <span className="dispatcher-live-dot" aria-hidden="true" />
            Демонстрационные данные
          </div>
          <h2 id="performance-title">
            Реклама привела <strong>{count(t.leads)} обращений</strong>
          </h2>
          <p>
            {s.running
              ? "Демо: реклама работает. Ритм следит за результатом и бережёт бюджет."
              : "Демо: реклама на паузе. Данные и настройки сохранены."}
          </p>
          <div
            className="dispatcher-source-breakdown"
            aria-label="Источники обращений"
          >
            <span>
              Поиск <b>{count(Math.round(t.leads * 0.62))}</b>
            </span>
            <span>
              Рекламная сеть{" "}
              <b>{count(Math.max(0, t.leads - Math.round(t.leads * 0.62)))}</b>
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={pause}
          disabled={busy || !s.campaigns.length}
          className="dispatcher-pause"
        >
          {s.running ? <Pause size={15} /> : <Play size={15} />}
          {s.running ? "На паузу" : "Продолжить"}
        </button>
      </section>

      <section
        className="dispatcher-budget"
        aria-labelledby="dispatcher-budget-title"
      >
        <div className="dispatcher-budget-copy">
          <span id="dispatcher-budget-title">Бюджет на период</span>
          <b>{money(s.budget)}</b>
          <small>Потрачено {money(t.spent)}</small>
        </div>
        <div className="dispatcher-budget-meter-row">
          <div
            className="dispatcher-budget-progress"
            aria-label={`Использовано ${Math.round(spendProgress * 100)} процентов бюджета`}
          >
            <i style={{ width: `${spendProgress * 100}%` }} />
          </div>
          <button type="button" onClick={budget}>
            Настроить <ArrowRight size={14} />
          </button>
        </div>
      </section>

      <section
        className="dispatcher-trend"
        aria-labelledby="dispatcher-trend-title"
      >
        <header className="dispatcher-trend-header">
          <div>
            <h2 id="dispatcher-trend-title">Обращения по дням</h2>
            <p>Сколько заявок принесла реклама в каждый тестовый день</p>
          </div>
          <div className="dispatcher-trend-actions">
            <div className="dispatcher-trend-totals" aria-label="Итоги графика">
              <div>
                <span>За весь период</span>
                <b>{count(t.leads)}</b>
              </div>
              <div>
                <span>В среднем за день</span>
                <b>
                  {averageLeads.toLocaleString("ru-RU", {
                    maximumFractionDigits: 1,
                  })}
                </b>
              </div>
            </div>
            <div
              className="dispatcher-trend-display-toggle"
              role="group"
              aria-label="Вид графика"
            >
              <button
                type="button"
                className={chartMode === "line" ? "active" : ""}
                aria-pressed={chartMode === "line"}
                onClick={() => setChartMode("line")}
              >
                <ChartLine size={15} /> Линия
              </button>
              <button
                type="button"
                className={chartMode === "bars" ? "active" : ""}
                aria-pressed={chartMode === "bars"}
                onClick={() => setChartMode("bars")}
              >
                <BarChart3 size={15} /> Столбцы
              </button>
            </div>
          </div>
        </header>
        <div className="dispatcher-trend-legend">
          <span>
            <i
              className={chartMode === "bars" ? "is-bars" : ""}
              aria-hidden="true"
            />{" "}
            Количество обращений
          </span>
          <span>
            {chartMode === "line"
              ? "Наведи на точку, чтобы увидеть день и расход"
              : "Наведи на столбец, чтобы увидеть день и расход"}
          </span>
        </div>
        <Chart daily={s.daily} mode={chartMode} />
      </section>

      <section
        className="dispatcher-inbox"
        aria-labelledby="dispatcher-inbox-title"
      >
        <header className="dispatcher-inbox-header">
          <div>
            <span className="dispatcher-section-label">Тестовая очередь</span>
            <h2 id="dispatcher-inbox-title">Новые обращения</h2>
          </div>
          <span className="dispatcher-count">{count(t.leads)}</span>
        </header>
        <div className="dispatcher-inbox-toolbar">
          <div className="dispatcher-filters" aria-label="Фильтр обращений">
            {(
              [
                ["all", "Все"],
                ["new", "Новые"],
                ["contacted", "Ответили"],
                ["booked", "Записаны"],
              ] as const
            ).map(([id, label]) => (
              <button
                type="button"
                key={id}
                aria-pressed={inquiryFilter === id}
                onClick={() => setInquiryFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="dispatcher-history-link"
            onClick={() => select("history")}
          >
            История <ArrowRight size={14} />
          </button>
        </div>
        <div className="dispatcher-inquiry-list" role="list">
          {visibleInquiries.map((inquiry, index) => (
            <article
              className={`dispatcher-inquiry ${index === 0 ? "is-current" : ""}`}
              key={inquiry.id}
              role="listitem"
            >
              <span className="dispatcher-inquiry-avatar" aria-hidden="true">
                {inquiry.initials}
              </span>
              <div className="dispatcher-inquiry-person">
                <b>{inquiry.name}</b>
                <small>{inquiry.source}</small>
              </div>
              <p>{inquiry.message}</p>
              <span className={`dispatcher-inquiry-status ${inquiry.status}`}>
                {inquiry.statusLabel}
              </span>
              <button
                type="button"
                aria-label={`Открыть историю обращения от ${inquiry.name}`}
                onClick={() => select("history")}
              >
                <ChevronRight size={17} />
              </button>
            </article>
          ))}
          {!visibleInquiries.length && (
            <div className="dispatcher-empty">
              В этой группе пока нет обращений.
            </div>
          )}
        </div>
      </section>

      <aside
        className="dispatcher-actions"
        aria-labelledby="dispatcher-actions-title"
      >
        <header>
          <div>
            <span className="dispatcher-section-label">Путь запуска</span>
            <h2 id="dispatcher-actions-title">Дерево рекламы</h2>
            <p>
              Каждый готовый этап помогает рекламе расти — без лишних действий и
              расходов.
            </p>
          </div>
          <div
            className="dispatcher-growth-score"
            aria-label={`Готово ${rhythmReady} из ${rhythmStages.length} этапов`}
          >
            <b>{rhythmReady}</b>
            <span>
              из {rhythmStages.length}
              <small>этапов</small>
            </span>
          </div>
        </header>
        <ol
          className="dispatcher-growth-map"
          aria-label="Этапы запуска рекламы"
        >
          {rhythmStages.map((stage, index) => (
            <li className={stage.done ? "done" : "pending"} key={stage.label}>
              <span className="dispatcher-growth-tree" aria-hidden="true">
                <img src={rhythmGrowthImages[index]} alt="" />
              </span>
              <span className="dispatcher-growth-copy">
                <b>
                  <em>{index + 1}</em>
                  {stage.label}
                </b>
                <small>{stage.description}</small>
              </span>
              <span className="dispatcher-growth-status">
                {stage.done ? (
                  <>
                    <Check size={12} aria-hidden="true" /> Готово
                  </>
                ) : (
                  "Следующий шаг"
                )}
              </span>
            </li>
          ))}
        </ol>
        <footer className="dispatcher-growth-footer">
          <span>
            {nextRhythmStage
              ? `Следующий шаг — «${nextRhythmStage.label}». Ритм подскажет, что сделать.`
              : "Все этапы готовы. Теперь Ритм следит за результатом и бережёт бюджет."}
          </span>
          <button type="button" onClick={() => select("campaigns")}>
            {nextRhythmStage ? "Продолжить" : "Открыть рекламу"}{" "}
            <ArrowRight size={14} />
          </button>
        </footer>
      </aside>

      <aside
        className="dispatcher-recommendations"
        aria-labelledby="dispatcher-recommendations-title"
      >
        <header>
          <span className="dispatcher-section-label">Рекомендации Ритма</span>
          <h2 id="dispatcher-recommendations-title">
            На что обратить внимание
          </h2>
        </header>
        <article>
          <span className="dispatcher-recommendation-icon">
            <Sparkles size={17} />
          </span>
          <div>
            <b>
              {s.aiPlan
                ? "План рекламы подготовлен"
                : "Нужен короткий рассказ о бизнесе"}
            </b>
            <p>
              {s.aiPlan
                ? "Аудитории, объявления и бюджет уже собраны. Осталось проверить итог."
                : "Рита сама соберёт данные и предложит рекламный план."}
            </p>
            <button type="button" onClick={() => select("campaigns")}>
              {s.aiPlan ? "Открыть план" : "Рассказать о бизнесе"}{" "}
              <ArrowRight size={14} />
            </button>
          </div>
        </article>
        <article>
          <span className="dispatcher-recommendation-icon quiet">
            <ShieldCheck size={17} />
          </span>
          <div>
            <b>
              {t.cpa !== null && t.cpa <= s.targetCpa
                ? "Стоимость обращения в пределах цели"
                : "Проверьте стоимость обращения"}
            </b>
            <p>
              Сейчас {money(t.cpa)} при цели до {money(s.targetCpa)}.
            </p>
            <button type="button" onClick={() => select("advisor")}>
              Посмотреть анализ <ArrowRight size={14} />
            </button>
          </div>
        </article>
      </aside>

      <div
        className="dispatcher-incoming-toast"
        role="status"
        aria-live="polite"
      >
        <span className="dispatcher-inquiry-avatar" aria-hidden="true">
          АК
        </span>
        <div>
          <small>Новое тестовое обращение</small>
          <b>Анна хочет записаться</b>
        </div>
        <CheckCircle2 size={18} aria-hidden="true" />
      </div>
    </div>
  );
}
function Metric({
  label,
  value,
  hint,
  progress,
  accent,
  good,
}: {
  label: string;
  value: string;
  hint: string;
  progress?: number;
  accent?: boolean;
  good?: boolean;
}) {
  return (
    <section className={"metric card " + (accent ? "metric-accent" : "")}>
      <div className="metric-label">{label}</div>
      <b className="metric-value">{value}</b>
      <p className={good ? "good" : ""}>
        {good && <ArrowDownRight size={15} />} {hint}
      </p>
      {progress !== undefined && (
        <div className="micro-progress">
          <i style={{ width: Math.min(100, progress * 100) + "%" }} />
        </div>
      )}
    </section>
  );
}
function Chart({
  daily,
  mode,
}: {
  daily: Business["daily"];
  mode: "line" | "bars";
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [compact, setCompact] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia("(max-width: 520px)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(max-width: 520px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  if (!daily.length)
    return (
      <Empty
        title="Скоро здесь появится график"
        text="Запустите тестовый план и смоделируйте первый день."
      />
    );
  const data = daily.slice(-10),
    rawMax = Math.max(1, ...data.map((d) => d.leads)),
    max = Math.max(4, Math.ceil(rawMax / 4) * 4),
    chartWidth = compact ? 360 : 880,
    chartHeight = compact ? 238 : 270,
    plotLeft = compact ? 38 : 64,
    plotRight = compact ? 344 : 824,
    plotTop = compact ? 28 : 45,
    plotBottom = compact ? 180 : 205,
    plotWidth = plotRight - plotLeft,
    plotHeight = plotBottom - plotTop,
    x = (i: number) =>
      plotLeft + i * (plotWidth / Math.max(1, data.length - 1)),
    y = (v: number) => plotBottom - (v / max) * plotHeight,
    barStep = plotWidth / data.length,
    barWidth = Math.min(compact ? 22 : 52, barStep * 0.62),
    barX = (i: number) => plotLeft + i * barStep + (barStep - barWidth) / 2,
    labelY = compact ? 214 : 238;
  const points = data.map((d, i) => `${x(i)},${y(d.leads)}`).join(" ");
  return (
    <div className="chart" onMouseLeave={() => setHover(null)}>
      <svg
        className={compact ? "chart-svg chart-svg-compact" : "chart-svg"}
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        role="img"
        aria-label={`${mode === "line" ? "Линейный" : "Столбчатый"} график количества обращений по тестовым дням`}
      >
        {mode === "line" && (
          <defs>
            <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
              <stop className="chart-area-start" offset="0%" />
              <stop className="chart-area-end" offset="100%" />
            </linearGradient>
          </defs>
        )}
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <line
              className="chart-grid-line"
              x1={plotLeft}
              x2={plotRight}
              y1={plotTop + (i * plotHeight) / 3}
              y2={plotTop + (i * plotHeight) / 3}
            />
            <text
              x={plotLeft - (compact ? 8 : 16)}
              y={plotTop + 5 + (i * plotHeight) / 3}
              textAnchor="end"
            >
              {Math.round(max * (1 - i / 3))}
            </text>
          </g>
        ))}
        {mode === "line" ? (
          <>
            <polygon
              points={`${plotLeft},${plotBottom} ${points} ${x(data.length - 1)},${plotBottom}`}
              fill="url(#area)"
            />
            <polyline className="chart-line" points={points} fill="none" />
          </>
        ) : (
          data.map((d, i) => (
            <rect
              className={`chart-bar ${hover === i ? "is-hover" : ""}`}
              key={`bar-${i}`}
              x={barX(i)}
              y={y(d.leads)}
              width={barWidth}
              height={plotBottom - y(d.leads)}
              rx="5"
            />
          ))
        )}
        {data.map((d, i) => (
          <g
            key={i}
            onMouseEnter={() => setHover(i)}
            tabIndex={0}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            aria-label={`Тестовый день ${d.label}, обращений ${d.leads}`}
          >
            {mode === "line" ? (
              <>
                <circle
                  cx={x(i)}
                  cy={y(d.leads)}
                  r={compact ? 14 : 18}
                  fill="transparent"
                />
                <circle
                  className="chart-point"
                  cx={x(i)}
                  cy={y(d.leads)}
                  r={hover === i ? 6 : 4}
                />
              </>
            ) : (
              <rect
                x={barX(i) - 8}
                y={plotTop - 7}
                width={barWidth + 16}
                height={plotHeight + 16}
                fill="transparent"
              />
            )}
            {(i % 2 === 0 || i === data.length - 1) && (
              <text
                x={mode === "line" ? x(i) : barX(i) + barWidth / 2}
                y={labelY}
                textAnchor="middle"
              >
                {d.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      {hover !== null && (
        <div className="chart-tooltip">
          Тестовый день {data[hover].label} ·{" "}
          <b>{data[hover].leads} обращений</b> · {money(data[hover].spent)}
        </div>
      )}
      <span className="chart-caption">
        Дни — слева направо. Высота {mode === "line" ? "линии" : "столбца"}{" "}
        показывает количество обращений.
      </span>
    </div>
  );
}
type LaunchReadiness = {
  ready: boolean;
  status: "ready_for_review" | "needs_setup";
  title: string;
  detail: string;
  blockers: { code: string; title: string; detail: string }[];
};

function HostedPlanReview({
  ws,
  busy,
  navigate,
  editBusiness,
  prepareAiPlan,
  preflight,
  confirmPlan,
  executePlan,
  inspectExecution,
  inspectControl,
  refresh,
}: {
  ws: Workspace;
  busy: boolean;
  navigate: (page: string) => void;
  editBusiness: () => void;
  prepareAiPlan: () => void;
  preflight: (id: string) => void;
  confirmPlan: (id: string, planFingerprint: string) => void;
  executePlan: (
    id: string,
    planFingerprint: string,
    name: string,
    budget: number,
  ) => void;
  inspectExecution: (id: string) => void;
  inspectControl: (id: string) => Promise<boolean> | boolean | void;
  refresh: () => Promise<void>;
}) {
  const plan = ws.state.aiPlan;
  const [readiness, setReadiness] = useState<LaunchReadiness | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [preparingCampaigns, setPreparingCampaigns] = useState(false);
  const [selectedChangeId, setSelectedChangeId] = useState("");
  const [confirmed, setConfirmed] = useState(
    Boolean(ws.state.postgresPilot?.planConfirmedAt),
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [draftAcknowledged, setDraftAcknowledged] = useState(false);
  const [localError, setLocalError] = useState("");
  const approvedTexts = ws.state.creatives.filter(
    (item) => item.status === "approved",
  );
  const yandex = ws.connections.find((item) => item.provider === "yandex");
  const directLogin = yandex?.clients?.[0]?.Login || "";
  const directReadyImages = ws.creativeImages.filter(
    (image) =>
      image.approvedAt &&
      image.directUploads.some((upload) => upload.login === directLogin),
  );
  const [creativeAssetId, setCreativeAssetId] = useState(
    directReadyImages[0]?.id || "",
  );
  const selectedCreativeImage =
    directReadyImages.find((image) => image.id === creativeAssetId) ||
    directReadyImages[0] ||
    null;
  useEffect(() => {
    if (directReadyImages.some((image) => image.id === creativeAssetId)) return;
    setCreativeAssetId(directReadyImages[0]?.id || "");
  }, [directLogin, ws.creativeImages]);
  const allocation = plan?.plan.budgetAllocation || [];
  const useNetwork = Boolean(plan?.plan.channels.includes("network"));
  const expectedChannelCount = useNetwork ? 2 : 1;
  const networkPercent = useNetwork
    ? Math.min(
        45,
        Math.max(
          25,
          allocation.find((item) => item.channel === "network")?.percent || 35,
        ),
      )
    : 0;
  const networkBudget = useNetwork
    ? Math.max(1, Math.floor((ws.state.budget * networkPercent) / 100))
    : 0;
  const searchBudget = ws.state.budget - networkBudget;
  const matchingDirectChanges = ws.directChanges.filter((item) => {
    if (!item.plan || item.plan.website !== ws.state.website) return false;
    if (item.plan.channel === "network")
      return (
        useNetwork &&
        item.plan.budget === networkBudget &&
        item.plan.creativeAssetId === creativeAssetId &&
        item.plan.ads.every(
          (ad) =>
            ad.titles.every((title) =>
              approvedTexts.some(
                (creative) => creative.title.slice(0, 56) === title,
              ),
            ) &&
            ad.texts.every((text) =>
              approvedTexts.some(
                (creative) => creative.text.slice(0, 81) === text,
              ),
            ),
        )
      );
    return (
      item.plan.budget === searchBudget &&
      (creativeAssetId
        ? item.plan.creativeAssetId === creativeAssetId
        : !item.plan.creativeAssetId) &&
      item.plan.ads.every((ad) =>
        approvedTexts.some(
          (creative) =>
            creative.title.slice(0, 56) === ad.title &&
            creative.text.slice(0, 81) === ad.text,
        ),
      )
    );
  });
  const directChanges = (["search", "network"] as const).flatMap((channel) => {
    const candidates = matchingDirectChanges
      .filter((item) => (item.plan?.channel || "search") === channel)
      .sort((left, right) => {
        const succeeded =
          Number(right.execution?.status === "succeeded") -
          Number(left.execution?.status === "succeeded");
        if (succeeded) return succeeded;
        const rightUpdated = Date.parse(
          right.updatedAt || right.createdAt || "",
        );
        const leftUpdated = Date.parse(left.updatedAt || left.createdAt || "");
        return (
          (Number.isFinite(rightUpdated) ? rightUpdated : 0) -
          (Number.isFinite(leftUpdated) ? leftUpdated : 0)
        );
      });
    return candidates.slice(0, 1);
  });
  const nextIncompleteChange = directChanges.find(
    (item) => item.execution?.status !== "succeeded",
  );
  const directChange =
    directChanges.find((item) => item.id === selectedChangeId) ||
    nextIncompleteChange ||
    directChanges[0] ||
    null;
  useEffect(() => {
    if (nextIncompleteChange) setSelectedChangeId(nextIncompleteChange.id);
    else if (
      selectedChangeId &&
      !directChanges.some((item) => item.id === selectedChangeId)
    )
      setSelectedChangeId("");
  }, [ws.directChanges]);
  const directPreflightFresh = Boolean(
    directChange?.preflight &&
    Date.parse(directChange.preflight.checkedAt) + 10 * 60_000 > Date.now(),
  );
  const period = nextCampaignPeriod("", "");
  const regionId = /екатеринбург/i.test(ws.state.city) ? 54 : null;

  async function prepareHeldDraft() {
    if (
      !plan ||
      approvedTexts.length < 3 ||
      !yandex?.clients?.[0] ||
      !regionId ||
      !creativeAssetId
    )
      return;
    setPreparingCampaigns(true);
    setLocalError("");
    const searchPlan: DirectPlan = {
      login: yandex.clients[0].Login,
      campaignName: `${ws.state.name} · Поиск`.slice(0, 255),
      website: ws.state.website,
      audience: plan.plan.audiences.map((item) => item.name).join("; "),
      regionIds: [regionId],
      budget: searchBudget,
      targetCpa: ws.state.targetCpa,
      periodStart: period.start,
      periodEnd: period.end,
      ...(ws.state.counterId ? { counterId: ws.state.counterId } : {}),
      ...(ws.state.goalId ? { goalId: ws.state.goalId } : {}),
      ...(creativeAssetId ? { creativeAssetId } : {}),
      ads: approvedTexts.map((item) => ({
        title: item.title.slice(0, 56),
        text: item.text.slice(0, 81),
        href: ws.state.website,
      })),
      keywords: plan.plan.keywords,
      negativeKeywords: plan.plan.negativeKeywords,
    };
    const networkPlan: DirectNetworkPlan = {
      channel: "network",
      login: yandex.clients[0].Login,
      campaignName: `${ws.state.name} · Рекламная сеть`.slice(0, 255),
      website: ws.state.website,
      audience: plan.plan.audiences.map((item) => item.name).join("; "),
      regionIds: [regionId],
      budget: networkBudget,
      periodStart: period.start,
      periodEnd: period.end,
      ...(ws.state.counterId ? { counterId: ws.state.counterId } : {}),
      ...(ws.state.goalId ? { goalId: ws.state.goalId } : {}),
      creativeAssetId,
      ads: [
        {
          titles: approvedTexts
            .slice(0, 3)
            .map((item) => item.title.slice(0, 56)),
          texts: approvedTexts
            .slice(0, 3)
            .map((item) => item.text.slice(0, 81)),
          href: ws.state.website,
        },
      ],
    };
    let requestFailed = false;
    try {
      const preparedChannels = new Set(
        directChanges.map((item) => item.plan?.channel || "search"),
      );
      const missingCampaigns = (
        [
          searchPlan,
          ...(useNetwork ? [networkPlan] : []),
        ] satisfies AnyDirectPlan[]
      ).filter(
        (campaign) => !preparedChannels.has(campaign.channel || "search"),
      );
      for (const campaign of missingCampaigns)
        await api(`/businesses/${ws.id}/direct/dry-run`, campaign);
    } catch (cause) {
      requestFailed = true;
      setLocalError(
        cause instanceof Error
          ? cause.message
          : "Не удалось подготовить направления. Попробуйте ещё раз.",
      );
    } finally {
      try {
        await refresh();
      } catch {
        if (!requestFailed)
          setLocalError(
            "Направления подготовлены, но экран не обновился. Обновите страницу.",
          );
      }
      setPreparingCampaigns(false);
    }
  }

  async function checkReadiness() {
    setChecking(true);
    setLocalError("");
    try {
      setReadiness(
        await api(`/businesses/${ws.id}/launch-readiness`, undefined),
      );
    } catch (cause) {
      setLocalError(
        cause instanceof Error
          ? cause.message
          : "Не удалось проверить подготовку. Попробуйте ещё раз.",
      );
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    void checkReadiness();
  }, [ws.id, plan?.inputHash, ws.state.website, ws.connections.length]);

  useEffect(() => {
    setConfirmed(Boolean(ws.state.postgresPilot?.planConfirmedAt));
  }, [ws.state.postgresPilot?.planConfirmedAt]);

  async function confirmPreparedPlan() {
    setConfirming(true);
    setLocalError("");
    try {
      await api(`/businesses/${ws.id}/launch-readiness/confirm`, {
        confirmed: true,
      });
      setConfirmed(true);
      await refresh();
    } catch (cause) {
      setLocalError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сохранить подтверждение. Попробуйте ещё раз.",
      );
    } finally {
      setConfirming(false);
    }
  }

  function blockerAction(code: string) {
    if (code === "plan" || code === "plan_outdated")
      return { label: "Обновить план", action: prepareAiPlan };
    if (["website", "conversion", "yandex"].includes(code))
      return {
        label: "Перейти к подключению",
        action: () => navigate("connections"),
      };
    return {
      label: "Изменить данные бизнеса",
      action: editBusiness,
    };
  }

  if (!plan)
    return (
      <div className="direct-layout">
        <section className="card hosted-plan-empty">
          <div className="ai-plan-mark" aria-hidden="true">
            <Sparkles size={18} />
          </div>
          <div>
            <h2>Ритм подготовит первый план</h2>
            <p>
              Рита предложит аудиторию, объявления и распределение бюджета по
              данным вашего бизнеса.
            </p>
          </div>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={prepareAiPlan}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Sparkles size={16} />
            )}
            {busy ? "Готовим план…" : "Подготовить план"}
          </button>
        </section>
      </div>
    );

  return (
    <div className="direct-layout hosted-plan-layout">
      <section className="card ai-plan-card hosted-plan-summary">
        <div className="ai-plan-card-heading">
          <div className="ai-plan-mark" aria-hidden="true">
            <Sparkles size={18} />
          </div>
          <div>
            <h2>План готов к проверке</h2>
            <p>{plan.plan.summary}</p>
          </div>
          <button
            type="button"
            className="secondary ai-plan-button"
            onClick={editBusiness}
          >
            <SlidersHorizontal size={16} />
            Изменить данные
          </button>
        </div>
        <div className="ai-plan-summary">
          <div>
            <span>Кому покажем</span>
            <b>{plan.plan.audiences.map((item) => item.name).join(" · ")}</b>
          </div>
          <div>
            <span>Где начнём</span>
            <b>
              {plan.plan.channels
                .map((item) => (item === "search" ? "Поиск" : "Рекламная сеть"))
                .join(" + ")}
            </b>
          </div>
          <div>
            <span>Что проверим</span>
            <b>{plan.plan.abHypotheses[0]?.hypothesis || "Первую гипотезу"}</b>
          </div>
          <div>
            <span>Бюджет на период</span>
            <b>{money(ws.state.budget)}</b>
          </div>
        </div>
        {plan.plan.warnings.length > 0 && (
          <p className="ai-plan-warning">{plan.plan.warnings.join(" ")}</p>
        )}
        <p className="hosted-plan-source-note">
          План меняется вместе с данными бизнеса: услугой, преимуществами,
          бюджетом и страницей для клиентов.
        </p>
      </section>

      <section className="card hosted-launch-review" aria-live="polite">
        <header>
          <div>
            <Badge tone={readiness?.ready ? "green" : "neutral"}>
              {checking
                ? "Проверяем"
                : confirmed
                  ? "План сохранён"
                  : readiness?.ready
                    ? "Готово к подтверждению"
                    : "Нужны действия"}
            </Badge>
            <h2>
              {confirmed
                ? "План проверен — переходите к материалам"
                : readiness?.title || "Проверяем подготовку"}
            </h2>
            <p>
              {confirmed
                ? "Подготовка завершена. Новый вариант плана появится только после изменения данных бизнеса."
                : readiness?.detail ||
                  "Сверяем страницу, обращение, кабинет и бюджет."}
            </p>
          </div>
          {!confirmed && (
            <button
              type="button"
              className="secondary"
              disabled={checking}
              onClick={() => void checkReadiness()}
            >
              <RefreshCw className={checking ? "spin" : ""} size={16} />
              {checking ? "Проверяем…" : "Проверить снова"}
            </button>
          )}
        </header>

        {localError && (
          <div className="inline-error" role="alert">
            {localError}
          </div>
        )}

        {readiness?.blockers.length ? (
          <ol className="hosted-launch-blockers">
            {readiness.blockers.map((blocker, index) => {
              const action = blockerAction(blocker.code);
              return (
                <li key={blocker.code}>
                  <span>{index + 1}</span>
                  <div>
                    <b>{blocker.title}</b>
                    <p>{blocker.detail}</p>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={action.action}
                  >
                    {action.label} <ArrowRight size={15} />
                  </button>
                </li>
              );
            })}
          </ol>
        ) : readiness?.ready ? (
          confirmed ? (
            <div className="hosted-plan-complete">
              <div className="hosted-plan-next">
                <span className="hosted-plan-next-icon" aria-hidden="true">
                  <Images size={20} />
                </span>
                <div>
                  <h3>
                    {directReadyImages.length
                      ? "Изображение готово для рекламы"
                      : "Теперь подготовьте изображения"}
                  </h3>
                  <p>
                    {directReadyImages.length
                      ? "Согласованный вариант добавлен в выбранный кабинет Директа."
                      : "Рита предложит сюжеты по вашему описанию. Вы сами выберете, какие варианты можно использовать в рекламе."}
                  </p>
                  <small>
                    После подготовки материалов останется отдельный запуск в
                    Директе. На этом сервере он пока отключён, поэтому показы и
                    расходы не начнутся.
                  </small>
                </div>
                <button
                  type="button"
                  className="primary"
                  onClick={() => navigate("creatives")}
                >
                  <Images size={16} />
                  {directReadyImages.length
                    ? "Проверить изображения"
                    : "Подготовить изображения"}
                </button>
              </div>
              <div className="hosted-direct-stage">
                <div className="hosted-direct-stage-heading">
                  <span className="hosted-plan-next-icon" aria-hidden="true">
                    <Send size={20} />
                  </span>
                  <div>
                    <h3>
                      {useNetwork
                        ? "Подготовьте поиск и Рекламную сеть"
                        : "Подготовьте поиск"}
                    </h3>
                    <p>
                      {useNetwork
                        ? "Ритм разделит общий бюджет между двумя направлениями и проверит каждое отдельно."
                        : "Для текущего бюджета Ритм начнёт с одного поискового направления."}{" "}
                      До вашего подтверждения показы и расходы не начнутся.
                    </p>
                  </div>
                </div>

                {approvedTexts.length >= 3 && selectedCreativeImage && (
                  <section
                    className="hosted-moderation-preview"
                    aria-labelledby="moderation-preview-title"
                  >
                    <header>
                      <div>
                        <span className="eyebrow">ИТОГОВАЯ ПРОВЕРКА</span>
                        <h4 id="moderation-preview-title">
                          Что уйдёт на модерацию Яндекса
                        </h4>
                        <p>
                          Фактические материалы запуска, а не декоративный
                          макет.
                        </p>
                      </div>
                      <Badge tone="green">Материалы выбраны</Badge>
                    </header>
                    <div className="hosted-moderation-content">
                      <figure>
                        {selectedCreativeImage.imageUrl && (
                          <img
                            src={selectedCreativeImage.imageUrl}
                            alt={`Выбранное изображение для рекламы «${ws.state.name}»`}
                          />
                        )}
                        <figcaption>
                          <b>Изображение</b>
                          <span>
                            {selectedCreativeImage.width &&
                            selectedCreativeImage.height
                              ? `${selectedCreativeImage.width} × ${selectedCreativeImage.height}`
                              : "Готовый файл"}
                            {selectedCreativeImage.brandPlacement === "none"
                              ? " · без надписи"
                              : ` · название ${selectedCreativeImage.brandPlacement === "bottom-left" ? "слева" : "справа"}`}
                          </span>
                        </figcaption>
                      </figure>
                      <div className="hosted-moderation-copy">
                        {approvedTexts.slice(0, 3).map((item, index) => (
                          <article key={item.id}>
                            <span>Вариант {index + 1}</span>
                            <h5>{item.title.slice(0, 56)}</h5>
                            <p>{item.text.slice(0, 81)}</p>
                          </article>
                        ))}
                      </div>
                    </div>
                    <dl className="hosted-moderation-facts">
                      <div>
                        <dt>Страница</dt>
                        <dd>{ws.state.website}</dd>
                      </div>
                      <div>
                        <dt>Как соберётся</dt>
                        <dd>
                          {useNetwork
                            ? "3 поисковых объявления и 1 адаптивное объявление в Рекламной сети"
                            : "3 отдельных объявления в поиске"}
                        </dd>
                      </div>
                    </dl>
                  </section>
                )}

                {approvedTexts.length < 3 ? (
                  <div className="hosted-direct-action">
                    <div>
                      <b>Разрешите три варианта текста</b>
                      <small>
                        Готово {approvedTexts.length} из 3. Каждый вариант
                        станет отдельным поисковым объявлением; отправка в
                        Яндекс начнётся только после итоговой проверки.
                      </small>
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => navigate("creatives")}
                    >
                      Перейти к текстам <ArrowRight size={15} />
                    </button>
                  </div>
                ) : directReadyImages.length === 0 ? (
                  <div className="hosted-direct-action">
                    <div>
                      <b>Выберите изображение для рекламы</b>
                      <small>
                        Ритм прикрепит его к объявлениям в Директе. Без
                        выбранного изображения новый запуск не подготовится.
                      </small>
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => navigate("creatives")}
                    >
                      Подготовить изображение <ArrowRight size={15} />
                    </button>
                  </div>
                ) : !regionId ? (
                  <div className="inline-error" role="alert">
                    Для города «{ws.state.city}» пока не найден точный регион
                    Директа. Добавьте выбор региона перед подготовкой кампании.
                  </div>
                ) : !directChange ? (
                  <div className="hosted-direct-ready">
                    <div className="hosted-direct-action">
                      <div>
                        <b>Материалы готовы</b>
                        <small>
                          {useNetwork
                            ? `Поиск ${money(searchBudget)} · Рекламная сеть ${money(networkBudget)} · общий лимит ${money(ws.state.budget)}`
                            : `Поиск · общий лимит ${money(ws.state.budget)}`}
                        </small>
                        <label className="hosted-image-choice">
                          Выбранное изображение
                          <select
                            value={creativeAssetId}
                            onChange={(event) =>
                              setCreativeAssetId(event.target.value)
                            }
                          >
                            {directReadyImages.map((image, index) => (
                              <option key={image.id} value={image.id}>
                                Согласованный вариант {index + 1}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <button
                        type="button"
                        className="primary"
                        disabled={busy || preparingCampaigns}
                        onClick={() => void prepareHeldDraft()}
                      >
                        {preparingCampaigns ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <ShieldCheck size={16} />
                        )}
                        {preparingCampaigns
                          ? useNetwork
                            ? "Готовим два направления…"
                            : "Готовим поиск…"
                          : "Подготовить именно эти материалы"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="hosted-direct-progress" aria-live="polite">
                    <div className="hosted-channel-summary">
                      <span>
                        Подготовлено направлений:{" "}
                        <b>
                          {directChanges.length} из {expectedChannelCount}
                        </b>
                      </span>
                      <span>
                        Общий лимит: <b>{money(ws.state.budget)}</b>
                      </span>
                    </div>
                    {directChanges.length > 1 && (
                      <div
                        className="hosted-channel-switch"
                        aria-label="Направления рекламы"
                      >
                        {directChanges.map((change) => (
                          <button
                            type="button"
                            key={change.id}
                            className={
                              change.id === directChange.id ? "active" : ""
                            }
                            onClick={() => setSelectedChangeId(change.id)}
                          >
                            <span>
                              {change.plan?.channel === "network"
                                ? "Рекламная сеть"
                                : "Поиск"}
                            </span>
                            <small>
                              {change.execution?.status === "succeeded"
                                ? "Черновик создан"
                                : change.preflight?.ready
                                  ? "Проверка пройдена"
                                  : "Нужно проверить"}
                            </small>
                          </button>
                        ))}
                      </div>
                    )}
                    {directChanges.length < expectedChannelCount && (
                      <div className="inline-error" role="status">
                        <b>Одно направление ещё не подготовлено</b>
                        <p>
                          Уже сохранённая часть останется без изменений. Ритм
                          добавит только недостающее направление.
                        </p>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy || preparingCampaigns}
                          onClick={() => void prepareHeldDraft()}
                        >
                          {preparingCampaigns ? (
                            <LoaderCircle className="spin" size={16} />
                          ) : (
                            <RefreshCw size={16} />
                          )}
                          Подготовить второе направление
                        </button>
                      </div>
                    )}
                    <div className="hosted-direct-progress-row complete">
                      <CheckCircle2 size={18} />
                      <div>
                        <b>
                          {directChange.plan?.channel === "network"
                            ? "Рекламная сеть подготовлена"
                            : "Поиск подготовлен"}
                        </b>
                        <small>
                          Лимит {money(directChange.plan?.budget || 0)} ·{" "}
                          {directChange.plan?.channel === "network"
                            ? `${directChange.summary.ads} адаптивное объявление с изображением`
                            : `${directChange.summary.ads} объявления · ${directChange.summary.keywords} фразы`}
                        </small>
                      </div>
                    </div>

                    {!directChange.execution &&
                      (!directChange.preflight || !directPreflightFresh) && (
                        <button
                          type="button"
                          className="primary"
                          disabled={busy}
                          onClick={() => preflight(directChange.id)}
                        >
                          <ShieldCheck size={16} />
                          {directChange.preflight
                            ? "Проверить кабинет снова"
                            : "Проверить кабинет и лимит"}
                        </button>
                      )}

                    {!directChange.execution &&
                      directChange.preflight &&
                      directPreflightFresh &&
                      !directChange.preflight.ready && (
                        <div className="inline-error" role="alert">
                          <b>До создания кампании нужно исправить:</b>
                          <ul>
                            {directChange.preflight.findings.map((finding) => (
                              <li key={finding.code}>{finding.message}</li>
                            ))}
                          </ul>
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => preflight(directChange.id)}
                          >
                            Проверить снова
                          </button>
                        </div>
                      )}

                    {directChange.preflight?.ready &&
                      directPreflightFresh &&
                      !directChange.approval && (
                        <div className="hosted-direct-confirmation">
                          <div className="hosted-direct-progress-row complete">
                            <CheckCircle2 size={18} />
                            <div>
                              <b>Кабинет и лимит проверены</b>
                              <small>В Директе пока ничего не создано.</small>
                            </div>
                          </div>
                          <label>
                            <input
                              type="checkbox"
                              checked={draftAcknowledged}
                              onChange={(event) =>
                                setDraftAcknowledged(event.target.checked)
                              }
                            />
                            <span>
                              Я понимаю: следующий шаг создаст только
                              выключенную кампанию без показов
                            </span>
                          </label>
                          <button
                            type="button"
                            className="primary"
                            disabled={!draftAcknowledged || busy}
                            onClick={() =>
                              confirmPlan(
                                directChange.id,
                                directChange.preflight!.planFingerprint,
                              )
                            }
                          >
                            Подтвердить подготовку черновика
                          </button>
                        </div>
                      )}

                    {directChange.approval && !directChange.execution && (
                      <div className="hosted-direct-action">
                        <div>
                          <b>Создание черновика подтверждено</b>
                          <small>
                            Подтверждение ограничено этим планом и действует 10
                            минут.
                          </small>
                        </div>
                        {ws.capabilities.directWritePilot ? (
                          <button
                            type="button"
                            className="primary"
                            disabled={busy}
                            onClick={() =>
                              executePlan(
                                directChange.id,
                                directChange.approval!.planFingerprint,
                                directChange.plan?.campaignName ||
                                  "Новая кампания",
                                directChange.plan?.budget || 0,
                              )
                            }
                          >
                            Создать выключенную кампанию
                          </button>
                        ) : (
                          <div className="hosted-direct-gate" role="status">
                            <b>Создание кампании пока недоступно</b>
                            <small>
                              План и проверка сохранены. Для первого создания в
                              рабочем кабинете нужно включить эту функцию на
                              сервере.
                            </small>
                          </div>
                        )}
                      </div>
                    )}

                    {directChange.execution?.status === "succeeded" && (
                      <div className="hosted-direct-success" role="status">
                        <CheckCircle2 size={20} />
                        <div>
                          <b>Выключенная кампания создана и сверена</b>
                          <p>
                            Она находится в Яндекс Директе, а не на вашем сайте.
                            Показы не идут. Следующий отдельный этап — модерация
                            и подтверждение запуска.
                          </p>
                        </div>
                      </div>
                    )}

                    {directChange.execution?.status === "succeeded" && (
                      <ModerationCard
                        businessId={ws.id}
                        changeId={directChange.id}
                        enabled={ws.capabilities.directModerationPilot}
                        clock={Date.now()}
                        busy={busy}
                        onCheckDecision={() => inspectControl(directChange.id)}
                      />
                    )}

                    {directChange.execution?.status === "succeeded" && (
                      <DirectControlCard
                        review={ws.controlReviews?.find(
                          (item) => item.changeId === directChange.id,
                        )}
                      />
                    )}

                    {directChange.execution?.status ===
                      "needs_reconciliation" && (
                      <div className="inline-error" role="alert">
                        <p>
                          Ответ Директа нужно сверить. Повторная отправка
                          заблокирована, чтобы не создать дубликат.
                        </p>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() => inspectExecution(directChange.id)}
                        >
                          Сверить с Директом
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="hosted-plan-confirmation">
              <div>
                <h3>Подтвердите подготовленный план</h3>
                <p>
                  Подтверждение сохранит результат проверки. Реклама и расходы
                  не начнутся.
                </p>
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>
                  Я просмотрел план и понимаю, что показы пока не начнутся
                </span>
              </label>
              <button
                type="button"
                className="primary"
                disabled={!acknowledged || confirming}
                onClick={() => void confirmPreparedPlan()}
              >
                {confirming ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <ShieldCheck size={16} />
                )}
                {confirming ? "Сохраняем…" : "Подтвердить план"}
              </button>
            </div>
          )
        ) : null}
      </section>
    </div>
  );
}

function AcceptanceRunCard({
  ws,
  busy,
  onRun,
}: {
  ws: Workspace;
  busy: boolean;
  onRun: () => void;
}) {
  const run = ws.acceptanceRuns?.[0] as AcceptanceRun | undefined;
  const report = run?.report as AcceptanceRunReport | null | undefined;
  const active = run && ["pending", "running"].includes(run.status);
  const runningLabel =
    run?.status === "running"
      ? "Проверяем автопилот на сохранённой копии…"
      : "Прогон ждёт фонового обработчика…";

  return (
    <section className="acceptance-run" aria-labelledby="acceptance-run-title">
      <div className="acceptance-run-intro">
        <div className="acceptance-run-mark" aria-hidden="true">
          <ShieldCheck size={22} />
        </div>
        <div>
          <span className="acceptance-run-kicker">Без пополнения кабинета</span>
          <h2 id="acceptance-run-title">Проверить автопилот на копии плана</h2>
          <p>
            Ритм воспроизведёт запуск, тестовый расход, решения автопилота и
            откат. В Яндекс Директ ничего не отправляется.
          </p>
        </div>
      </div>
      <div className="acceptance-run-action">
        <span>0 ₽ · без внешних изменений</span>
        <button
          type="button"
          className="primary"
          aria-busy={busy || active}
          disabled={busy || active}
          onClick={onRun}
        >
          {busy || active ? (
            <>
              <LoaderCircle className="spin" size={16} />
              {active ? runningLabel : "Ставим в очередь…"}
            </>
          ) : (
            <>
              <Play size={16} />
              Провести тестовый прогон
            </>
          )}
        </button>
      </div>
      {active && (
        <div
          className="acceptance-run-progress"
          role="status"
          aria-live="polite"
        >
          <LoaderCircle className="spin" size={18} aria-hidden="true" />
          <div>
            <b>{runningLabel}</b>
            <span>
              Задание сохранено на сервере. Страницу можно закрыть — проверка
              продолжится после перезапуска.
            </span>
          </div>
        </div>
      )}
      {run?.status === "failed" && (
        <div className="acceptance-run-error" role="alert">
          <div>
            <b>Прогон не завершён</b>
            <span>{run.error || "Рабочая реклама не менялась."}</span>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onRun}
          >
            <RefreshCw size={16} /> Повторить
          </button>
        </div>
      )}
      {report && (
        <div className="acceptance-run-result" role="status">
          <div className="acceptance-run-result-head">
            <div>
              <b>Прогон завершён: {report.checks.length} проверок пройдено</b>
              <small>
                {time(report.createdAt, ws.state.timezone)} · рабочая кампания
                не менялась
              </small>
            </div>
            <span className="acceptance-run-passed">
              <Check size={14} /> Готово
            </span>
          </div>
          <ol className="acceptance-run-checks">
            {report.checks.map((check) => (
              <li key={check.id}>
                <CheckCircle2 size={18} aria-hidden="true" />
                <div>
                  <b>{check.title}</b>
                  <span>{check.detail}</span>
                </div>
              </li>
            ))}
          </ol>
          <div className="acceptance-run-proof">
            <span>
              План: <b>{report.source.planName}</b>
            </span>
            <span>
              Тестовый лимит: <b>{money(report.source.budgetKopecks)}</b>
            </span>
            <span>
              Обращений к площадкам: <b>{report.providerCalls}</b>
            </span>
            <a
              className="acceptance-run-download"
              href={`/api/businesses/${ws.id}/acceptance-run/${run?.id}/protocol`}
            >
              <Download size={14} /> Скачать протокол
            </a>
          </div>
        </div>
      )}
    </section>
  );
}

function Campaigns({
  ws,
  busy,
  navigate,
  editBusiness,
  budget,
  launch,
  toggle,
  create,
  prepareAiPlan,
  dryRun,
  preflight,
  confirmPlan,
  executePlan,
  inspectExecution,
  suspendCampaign,
  inspectLifecycle,
  checkBudget,
  inspectControl,
  reviewShadow,
  refresh,
}: {
  ws: Workspace;
  busy: boolean;
  navigate: (page: string) => void;
  editBusiness: () => void;
  budget: () => void;
  launch: () => void;
  toggle: (c: Campaign) => void;
  create: () => void;
  prepareAiPlan: () => void;
  dryRun: (plan: DirectPlan) => void;
  preflight: (id: string) => void;
  confirmPlan: (id: string, planFingerprint: string) => void;
  executePlan: (
    id: string,
    planFingerprint: string,
    name: string,
    budget: number,
  ) => void;
  inspectExecution: (id: string) => void;
  suspendCampaign: (id: string, name: string, campaignId: number) => void;
  inspectLifecycle: (id: string, actionId: string) => void;
  checkBudget: (id: string) => void;
  inspectControl: (id: string) => Promise<boolean> | boolean | void;
  reviewShadow: (id: string) => void;
  refresh: () => Promise<void>;
}) {
  const [filter, setFilter] = useState("all"),
    [search, setSearch] = useState("");
  const data = ws.state.campaigns.filter(
    (c) =>
      (filter === "all" || c.status === filter) &&
      c.name.toLowerCase().includes(search.toLowerCase()),
  );
  if (ws.capabilities.postgresPilot)
    return (
      <HostedPlanReview
        ws={ws}
        busy={busy}
        navigate={navigate}
        editBusiness={editBusiness}
        prepareAiPlan={prepareAiPlan}
        preflight={preflight}
        confirmPlan={confirmPlan}
        executePlan={executePlan}
        inspectExecution={inspectExecution}
        inspectControl={inspectControl}
        refresh={refresh}
      />
    );
  if (ws.state.mode !== "demo" || ws.state.aiPlan)
    return (
      <DirectPlanBuilder
        ws={ws}
        busy={busy}
        navigate={navigate}
        prepareAiPlan={prepareAiPlan}
        submit={dryRun}
        preflight={preflight}
        confirmPlan={confirmPlan}
        executePlan={executePlan}
        inspectExecution={inspectExecution}
        suspendCampaign={suspendCampaign}
        inspectLifecycle={inspectLifecycle}
        checkBudget={checkBudget}
        inspectControl={inspectControl}
        reviewShadow={reviewShadow}
        refresh={refresh}
      />
    );
  return (
    <>
      <DirectPlanBuilder
        ws={ws}
        busy={busy}
        navigate={navigate}
        prepareAiPlan={prepareAiPlan}
        submit={dryRun}
        preflight={preflight}
        confirmPlan={confirmPlan}
        executePlan={executePlan}
        inspectExecution={inspectExecution}
        suspendCampaign={suspendCampaign}
        inspectLifecycle={inspectLifecycle}
        checkBudget={checkBudget}
        inspectControl={inspectControl}
        reviewShadow={reviewShadow}
        refresh={refresh}
      />
      <div className="toolbar">
        <div className="segmented">
          {[
            ["all", "Все направления"],
            ["active", "Работают"],
            ["paused", "На паузе"],
          ].map(([id, label]) => (
            <button
              className={id === filter ? "active" : ""}
              key={id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="search">
          <Search size={16} />
          <input
            aria-label="Поиск направления"
            placeholder="Найти направление"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button className="secondary" onClick={budget}>
          <Wallet size={16} />
          Бюджет
        </button>
      </div>
      <div className="card table-card">
        {!ws.state.campaigns.length ? (
          <Empty
            title="Ваш первый план рекламы"
            text="Подключите тестовую аналитику, согласуйте объявление и запустите план."
            action={
              <button className="primary" disabled={busy} onClick={launch}>
                <Play size={16} />
                Запустить план
              </button>
            }
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Направление</th>
                  <th>Статус</th>
                  <th>Расход</th>
                  <th>Обращения</th>
                  <th>Цена обращения</th>
                  <th>Лимит</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((c) => (
                  <tr key={c.id}>
                    <td data-label="Направление">
                      <div className="campaign-name">
                        <span className={"channel-icon " + c.channel}>
                          {c.channel === "search" ? (
                            <Search size={18} />
                          ) : (
                            <PanelsTopLeft size={18} />
                          )}
                        </span>
                        <div>
                          <b>{c.name}</b>
                          <small>
                            {c.channel === "search"
                              ? "Яндекс · Поиск"
                              : "Яндекс · Рекламная сеть"}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td data-label="Статус">
                      <Badge tone={c.status === "active" ? "green" : "gray"}>
                        <span className="badge-dot" />
                        {c.status === "active" ? "Работает" : "На паузе"}
                      </Badge>
                    </td>
                    <td data-label="Расход">{money(c.spent)}</td>
                    <td data-label="Обращения">{c.leads}</td>
                    <td data-label="Цена обращения">
                      {c.leads ? money(c.spent / c.leads) : "—"}
                    </td>
                    <td data-label="Лимит">{money(c.allocation)}</td>
                    <td className="table-row-action" data-label="Управление">
                      <button
                        className="icon-button"
                        disabled={busy}
                        aria-label={
                          (c.status === "active"
                            ? "Остановить "
                            : "Возобновить ") + c.name
                        }
                        onClick={() => toggle(c)}
                      >
                        {c.status === "active" ? (
                          <Pause size={16} />
                        ) : (
                          <Play size={16} />
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.length && (
              <Empty
                kicker="Нет совпадений"
                title="Ничего не найдено"
                text="Попробуйте другое название или выберите все направления."
              />
            )}
          </div>
        )}
      </div>
      <div className="info-box">
        <ShieldCheck size={22} />
        <span>
          <b>Общий бюджет — {money(ws.state.budget)}</b>
          <br />
          Лимиты направлений включают уже потраченные суммы. Резерв{" "}
          {ws.state.reservePercent}% не распределяется.
        </span>
      </div>
      <button className="text-button" onClick={create}>
        <Plus size={16} />
        Добавить другой бизнес
      </button>
    </>
  );
}

const moscowDateAfter = (days: number) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + days * 86_400_000));

const daysBetween = (start: string, end: string) =>
  (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
    86_400_000 +
  1;

function nextCampaignPeriod(previousStart = "", previousEnd = "") {
  const savedLength = daysBetween(previousStart, previousEnd);
  const days =
    Number.isInteger(savedLength) && savedLength >= 1 && savedLength <= 90
      ? savedLength
      : 14;
  return {
    start: moscowDateAfter(1),
    end: moscowDateAfter(days),
  };
}

const controlBlockers: Record<string, string> = {
  period_not_started: "Период кампании ещё не начался.",
  period_ended: "Период кампании завершён.",
  website_changed: "Сайт бизнеса отличается от сайта кампании.",
  budget_drift: "Лимит или стратегия отличаются от утверждённого плана.",
  campaign_not_suspended: "Кампания не находится в безопасном режиме ожидания.",
  campaign_under_review: "Яндекс ещё проверяет кампанию.",
  campaign_not_accepted: "Кампания ещё не принята модерацией.",
  payment_not_confirmed: "Директ не подтвердил возможность оплаты показов.",
  spend_not_verified: "Нет свежего отчёта о расходе за период кампании.",
  budget_exhausted: "Лимит кампании уже исчерпан.",
  group_mismatch:
    "Группа объявлений больше не соответствует сохранённому плану.",
  ads_under_review: "Яндекс ещё проверяет объявление.",
  ads_not_ready: "Объявление не принято или остановлено отдельно от кампании.",
  ad_content_changed:
    "Текст или ссылка объявления отличаются от утверждённого плана.",
  keywords_not_ready: "Ключевые фразы не готовы к показам.",
};

function DirectControlCard({ review }: { review?: DirectControlReview }) {
  const moderationPending = Boolean(
    review?.blockers.some((code) =>
      ["campaign_under_review", "ads_under_review"].includes(code),
    ),
  );
  const moderationUnresolved = Boolean(
    review?.blockers.some((code) =>
      [
        "campaign_under_review",
        "ads_under_review",
        "campaign_not_accepted",
        "ads_not_ready",
      ].includes(code),
    ),
  );
  const visibleBlockers =
    review?.blockers.filter(
      (code) =>
        !moderationUnresolved ||
        !["spend_not_verified", "payment_not_confirmed"].includes(code),
    ) || [];

  return (
    <div
      className="direct-execution-result direct-control-card"
      aria-live="polite"
    >
      <b>
        {moderationPending
          ? "Яндекс проверяет объявление"
          : moderationUnresolved
            ? "Яндекс ещё не разрешил показы"
            : "Проверка перед запуском"}
      </b>
      {review ? (
        <>
          {moderationUnresolved ? (
            <p>
              {moderationPending
                ? "Пока ничего исправлять не нужно. Объявление принято на проверку, показы не запущены и бюджет не расходуется."
                : "Показы пока не разрешены. Проверьте решение ещё раз; если статус не изменится, Яндекс покажет причину рядом с объявлением в Директе."}
            </p>
          ) : (
            <p>
              Ритм сверил состояние кампании, лимит{" "}
              {money(review.budget.limitKopecks)} и подтверждённый расход за
              период {money(review.budget.spentKopecks)}.
            </p>
          )}
          {!moderationUnresolved && review.budget.spentKopecks === null && (
            <small>
              {review.budget.reportDateTo
                ? `Последний сохранённый отчёт — по ${review.budget.reportDateTo}; он не подтверждает расход этой кампании за текущий период.`
                : "Отчёта о расходе за период кампании пока нет."}
            </small>
          )}
          {visibleBlockers.length && !moderationPending ? (
            <>
              <b className="launch-blockers-title">Что мешает запуску</b>
              <ul>
                {visibleBlockers.map((code) => (
                  <li key={code}>
                    {controlBlockers[code] ||
                      "Нужна дополнительная проверка кампании."}
                  </li>
                ))}
              </ul>
            </>
          ) : !moderationUnresolved ? (
            <p>
              Технические условия пройдены. Запуск требует отдельного решения
              владельца.
            </p>
          ) : null}
          <small>
            Проверено {new Date(review.checkedAt).toLocaleString("ru-RU")}. Эта
            проверка не меняет рекламу и не запускает показы.
          </small>
        </>
      ) : (
        <p>
          Проверим фактические статусы кампании, объявления, фраз и лимита перед
          любым решением о запуске.
        </p>
      )}
      <details>
        <summary>Что ещё потребуется перед запуском</summary>
        <ul>
          {(
            review?.manualChecks || [
              "Данные реального рекламодателя и проверенный сайт.",
              "Маркировка рекламы и прохождение модерации.",
              "Отдельное решение о показах и пределе расходов.",
            ]
          ).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

type ResumeAction = {
  id: string;
  campaignId: number;
  status:
    | "checking"
    | "sending"
    | "succeeded"
    | "failed_no_write"
    | "needs_reconciliation";
  writeAttempted: boolean;
};

function DirectResumeCard({
  businessId,
  changeId,
  review,
  enabled,
  clock,
}: {
  businessId: string;
  changeId: string;
  review?: DirectControlReview;
  enabled: boolean;
  clock: number;
}) {
  const [action, setAction] = useState<ResumeAction | null>(null);
  const [campaignInput, setCampaignInput] = useState("");
  const [limitInput, setLimitInput] = useState("");
  const [advertiser, setAdvertiser] = useState(false);
  const [site, setSite] = useState(false);
  const [marking, setMarking] = useState(false);
  const [spend, setSpend] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const keyName = `ritm:resume:${businessId}:${changeId}`;
  useEffect(() => {
    void api(`/businesses/${businessId}/direct/${changeId}/resume-actions`)
      .then((rows) => setAction((rows as ResumeAction[])[0] || null))
      .catch(() => {});
  }, [businessId, changeId]);
  const ready =
    !!review &&
    review.status === "technical_ready" &&
    clock >= Date.parse(review.checkedAt) &&
    clock - Date.parse(review.checkedAt) < 10 * 60_000;
  const limit = review?.budget.limitKopecks;
  const confirmed =
    campaignInput === String(review?.campaignId) &&
    limit !== null &&
    limit !== undefined &&
    limitInput === (limit / 100).toFixed(2) &&
    advertiser &&
    site &&
    marking &&
    spend;
  const locked = [
    "checking",
    "sending",
    "needs_reconciliation",
    "succeeded",
  ].includes(action?.status || "");
  async function resume() {
    if (!review || limit === null || limit === undefined) return;
    setPending(true);
    setError("");
    const requestKey = safeStorage.getItem(keyName) || crypto.randomUUID();
    safeStorage.setItem(keyName, requestKey);
    try {
      const next = (await api(
        `/businesses/${businessId}/direct/${changeId}/resume`,
        {
          advertiserConfirmed: advertiser,
          siteConfirmed: site,
          markingConfirmed: marking,
          spendConfirmed: spend,
          confirmCampaignId: Number(campaignInput),
          confirmLimitKopecks: limit,
        },
        "POST",
        requestKey,
      )) as ResumeAction;
      setAction(next);
      if (["succeeded", "failed_no_write"].includes(next.status))
        safeStorage.removeItem(keyName);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось выполнить запуск.",
      );
    } finally {
      setPending(false);
    }
  }
  async function reconcile() {
    if (!action) return;
    setPending(true);
    setError("");
    try {
      const next = (await api(
        `/businesses/${businessId}/direct/${changeId}/resume/${action.id}/inspect`,
        {},
      )) as ResumeAction;
      setAction(next);
      if (next.status === "succeeded") safeStorage.removeItem(keyName);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Сверка недоступна.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div
      className="direct-execution-result direct-control-card"
      aria-live="polite"
    >
      <b>Возобновление показов</b>
      <p>
        При запуске кампании №{review?.campaignId || "—"} Директ может начать
        списывать рекламный бюджет. Лимит периода: {money(limit ?? null)}.
      </p>
      {!enabled && (
        <small>
          Запуск на этом сервере выключен. Проверка готовности доступна выше.
        </small>
      )}
      {enabled && !ready && (
        <small>
          Сначала получите свежую проверку готовности без препятствий.
        </small>
      )}
      {action?.status === "succeeded" && (
        <strong role="status">Состояние ON подтверждено Директом.</strong>
      )}
      {action?.status === "needs_reconciliation" && (
        <div role="alert">
          <p>
            Результат запроса неизвестен. Повторный запуск запрещён до сверки.
          </p>
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={reconcile}
          >
            Сверить состояние
          </button>
        </div>
      )}
      {enabled && ready && !locked && (
        <div className="direct-moderation-confirm direct-resume-confirm">
          <label className="direct-resume-number">
            Номер кампании
            <input
              value={campaignInput}
              inputMode="numeric"
              onChange={(event) => setCampaignInput(event.target.value.trim())}
              placeholder={String(review?.campaignId)}
            />
          </label>
          <label className="direct-resume-number">
            Лимит периода, ₽
            <input
              value={limitInput}
              inputMode="decimal"
              onChange={(event) => setLimitInput(event.target.value.trim())}
              placeholder={
                limit === null || limit === undefined
                  ? ""
                  : (limit / 100).toFixed(2)
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={advertiser}
              onChange={(event) => setAdvertiser(event.target.checked)}
            />{" "}
            Я проверил настоящего рекламодателя
          </label>
          <label>
            <input
              type="checkbox"
              checked={site}
              onChange={(event) => setSite(event.target.checked)}
            />{" "}
            Я проверил работающий сайт и объявления
          </label>
          <label>
            <input
              type="checkbox"
              checked={marking}
              onChange={(event) => setMarking(event.target.checked)}
            />{" "}
            Я проверил маркировку и решение модерации
          </label>
          <label>
            <input
              type="checkbox"
              checked={spend}
              onChange={(event) => setSpend(event.target.checked)}
            />{" "}
            Я разрешаю реальные показы и расходы в пределах указанного лимита
          </label>
          <button
            type="button"
            className="primary"
            disabled={!confirmed || pending}
            onClick={resume}
          >
            {pending ? "Запускаем…" : "Возобновить показы в Директе"}
          </button>
        </div>
      )}
      {error && <small role="alert">{error}</small>}
    </div>
  );
}

function LiveShadowCard({
  review,
  job,
  busy,
  onReview,
}: {
  review?: LiveShadowReview;
  job?: Workspace["shadowReviewJobs"][number];
  busy: boolean;
  onReview: () => void;
}) {
  const direct = review?.source.direct;
  const metrica = review?.source.metrica;
  const attributed = review?.source.attributedMetrica;
  return (
    <div
      className="direct-execution-result direct-shadow-card"
      aria-live="polite"
    >
      <b>Сверка результатов</b>
      {review?.status === "observed" && direct && metrica ? (
        <>
          <p>
            За {direct.dateFrom} — {direct.dateTo} Директ показал по этой
            кампании расход {money(direct.spentKopecks ?? 0)},{" "}
            {count(direct.clicks ?? 0)} кликов и{" "}
            {count(direct.impressions ?? 0)} показов.
          </p>
          <p>
            Метрика за тот же период: {count(metrica.visits)} визитов и{" "}
            {count(metrica.goalReaches)} достижений цели по всему сайту.
          </p>
          {attributed && (
            <p>
              По точному ID этой кампании: {count(attributed.visits)} визитов и{" "}
              {count(attributed.goalReaches)} достижений цели
              {review.source.campaignCpaKopecks !== null
                ? `, цена достижения ${money(review.source.campaignCpaKopecks)}.`
                : "."}
            </p>
          )}
          <small>
            {review.reason}
            {!attributed && " Цена заявки по этой кампании не рассчитывается."}
            {review.action === "review_attribution"
              ? " Сначала проверьте, что обращение пришло именно из этой рекламы."
              : review.action === "review_campaign_performance"
                ? " Это shadow-сводка: она не меняет бюджет и не запускает объявления."
                : " Пока продолжайте наблюдение."}
          </small>
        </>
      ) : (
        <p>
          {review?.reason ||
            "После начала периода Ритм запросит отчёт Директа и сверит его с Метрикой. Проверку можно запустить и вручную."}
        </p>
      )}
      {job && ["pending", "running"].includes(job.status) && (
        <small>Автоматическая сверка выполняется в фоне.</small>
      )}
      {job?.status === "failed" && (
        <small>
          Автоматическая сверка не удалась. Попробуйте вручную после проверки
          подключения.
        </small>
      )}
      {review && (
        <small>
          Проверено {new Date(review.checkedAt).toLocaleString("ru-RU")}.
          Изменений в Директ эта сверка не отправляет.
        </small>
      )}
      <button
        type="button"
        className="secondary"
        disabled={
          busy || job?.status === "pending" || job?.status === "running"
        }
        onClick={onReview}
      >
        Сверить Директ и Метрику
      </button>
    </div>
  );
}

type DirectBudgetPreview = {
  mode: "read_only_preview";
  campaignId: number;
  ownerLimitKopecks: number;
  remoteLimitKopecks: number | null;
  proposedLimitKopecks: number;
  knownReportedSpentKopecks: number | null;
  blockers: string[];
  preliminaryChecksPassed: boolean;
  canApply: false;
  externalWrites: 0;
  notice: string;
};

type DirectBudgetAction = {
  id: string;
  campaignId: number;
  status:
    | "checking"
    | "sending"
    | "succeeded"
    | "failed_no_write"
    | "not_applied"
    | "needs_reconciliation";
  previousLimitKopecks: number;
  requestedLimitKopecks: number;
  confirmedLimitKopecks: number | null;
  writeAttempted: boolean;
  rollback: null | {
    status:
      | "checking"
      | "sending"
      | "succeeded"
      | "failed_no_write"
      | "not_applied"
      | "needs_reconciliation";
    writeAttempted: boolean;
    confirmedLimitKopecks: number | null;
    errorCode: string | null;
    updatedAt: string;
  };
  updatedAt: string;
};

type ModerationReadiness = {
  checkedAt: string;
  campaignId: number;
  adIds: (number | string)[];
  status: "blocked" | "technical_ready";
  blockers: string[];
  marking: {
    basicFieldsPresent: boolean;
    findings: string[];
  };
};
type ModerationAction = {
  id: string;
  status:
    | "checking"
    | "sending"
    | "succeeded"
    | "failed_no_write"
    | "needs_reconciliation";
  updatedAt: string;
};
const moderationBlockerText: Record<string, string> = {
  budget_drift: "Бюджет или период в Директе отличается от плана.",
  campaign_not_held: "Кампания не удерживается в выключенном состоянии.",
  period_ended: "Бюджетный период уже закончился.",
  website_changed: "Страница для клиентов отличается от страницы кампании.",
  advertiser_data_incomplete:
    "Директ пока не вернул все обязательные данные рекламодателя.",
  ads_not_draft: "Не все объявления находятся в статусе черновика.",
  ad_content_changed:
    "Заголовок, текст или ссылка объявления изменились в Директе.",
  keywords_mismatch: "Ключевые фразы не совпадают с созданной кампанией.",
  previous_action_unresolved: "Предыдущее действие модерации требует сверки.",
  campaign_action_unresolved: "Другое действие с кампанией требует сверки.",
};

function ModerationCard({
  businessId,
  changeId,
  enabled,
  clock,
  busy,
  onCheckDecision,
}: {
  businessId: string;
  changeId: string;
  enabled: boolean;
  clock: number;
  busy: boolean;
  onCheckDecision: () => Promise<boolean> | boolean | void;
}) {
  const [readiness, setReadiness] = useState<ModerationReadiness | null>(null);
  const [action, setAction] = useState<ModerationAction | null>(null);
  const [advertiserConfirmed, setAdvertiserConfirmed] = useState(false);
  const [siteConfirmed, setSiteConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [decisionPending, setDecisionPending] = useState(false);
  const [error, setError] = useState("");
  const keyName = `ritm:moderate:${businessId}:${changeId}`;
  useEffect(() => {
    void api(`/businesses/${businessId}/direct/${changeId}/moderation-actions`)
      .then((rows) => setAction((rows as ModerationAction[])[0] || null))
      .catch(() => {});
  }, [businessId, changeId]);
  async function inspect() {
    setPending(true);
    setError("");
    try {
      setReadiness(
        (await api(
          `/businesses/${businessId}/direct/${changeId}/moderation-readiness`,
        )) as ModerationReadiness,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось проверить модерацию.",
      );
    } finally {
      setPending(false);
    }
  }
  async function send() {
    setPending(true);
    setError("");
    const requestKey = safeStorage.getItem(keyName) || crypto.randomUUID();
    safeStorage.setItem(keyName, requestKey);
    try {
      const result = (await api(
        `/businesses/${businessId}/direct/${changeId}/moderate`,
        { advertiserConfirmed, siteConfirmed },
        "POST",
        requestKey,
      )) as ModerationAction;
      setAction(result);
      if (result.status === "failed_no_write") setReadiness(null);
      if (["succeeded", "failed_no_write"].includes(result.status))
        safeStorage.removeItem(keyName);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось отправить объявления.",
      );
    } finally {
      setPending(false);
    }
  }
  async function reconcile() {
    if (!action) return;
    setPending(true);
    setError("");
    try {
      const result = (await api(
        `/businesses/${businessId}/direct/${changeId}/moderation/${action.id}/inspect`,
        {},
      )) as ModerationAction;
      setAction(result);
      if (result.status === "succeeded") safeStorage.removeItem(keyName);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сверить состояние.",
      );
    } finally {
      setPending(false);
    }
  }
  async function checkDecision() {
    setDecisionPending(true);
    setError("");
    try {
      const checked = await onCheckDecision();
      if (checked === false)
        setError(
          "Не удалось получить решение Яндекса. Повторите проверку через несколько минут.",
        );
    } finally {
      setDecisionPending(false);
    }
  }
  const fresh =
    !!readiness && clock - Date.parse(readiness.checkedAt) < 10 * 60_000;
  return (
    <div className="direct-marking-check">
      <b>Модерация объявлений</b>
      <p>Отправка на проверку Яндекса не возобновляет показы кампании.</p>
      <button
        type="button"
        className="secondary"
        disabled={pending}
        onClick={inspect}
      >
        {pending ? "Проверяем…" : "Проверить готовность к модерации"}
      </button>
      {readiness && (
        <div className="direct-budget-preview-result" role="status">
          <strong>
            {readiness.status === "technical_ready"
              ? "Технические условия выполнены"
              : "До модерации есть препятствия"}
          </strong>
          <small>
            Кампания №{readiness.campaignId} · объявлений:{" "}
            {readiness.adIds.length} · внешних записей: 0
          </small>
          {readiness.blockers.length > 0 && (
            <ul>
              {readiness.blockers.map((code) => (
                <li key={code}>{moderationBlockerText[code] || code}</li>
              ))}
            </ul>
          )}
          {readiness.blockers.includes("advertiser_data_incomplete") &&
            readiness.marking.findings.length > 0 && (
              <div className="direct-moderation-guidance">
                <b>Что проверить в Директе</b>
                <ul>
                  {readiness.marking.findings.map((finding) => (
                    <li key={finding}>{finding}</li>
                  ))}
                </ul>
                <p>
                  Войдите в тот же кабинет, который подключён к Ритму. Нажмите
                  на логин → «Данные рекламодателя», оставьте включённым «Я —
                  конечный рекламодатель», проверьте тип, ИНН и ФИО или
                  название, затем сохраните. Данные плательщика в другом разделе
                  не подходят.
                </p>
                <a
                  href="https://direct.yandex.ru/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Открыть Яндекс Директ
                </a>
                <small>
                  Если вы только что сохранили данные, подождите несколько минут
                  и нажмите «Проверить готовность к модерации» ещё раз.
                </small>
              </div>
            )}
          <small>
            Данные рекламодателя, страницу для клиентов и тексты нужно проверить
            лично до отправки.
          </small>
        </div>
      )}
      {enabled &&
        readiness?.status === "technical_ready" &&
        !["succeeded", "needs_reconciliation", "checking", "sending"].includes(
          action?.status || "",
        ) && (
          <div className="direct-moderation-confirm">
            <label>
              <input
                type="checkbox"
                checked={advertiserConfirmed}
                onChange={(event) =>
                  setAdvertiserConfirmed(event.target.checked)
                }
              />{" "}
              Я проверил данные настоящего рекламодателя в Директе
            </label>
            <label>
              <input
                type="checkbox"
                checked={siteConfirmed}
                onChange={(event) => setSiteConfirmed(event.target.checked)}
              />{" "}
              Я проверил страницу для клиентов и тексты объявлений
            </label>
            <button
              type="button"
              className="primary"
              disabled={
                pending || !fresh || !advertiserConfirmed || !siteConfirmed
              }
              onClick={send}
            >
              Отправить {readiness.adIds.length} объявл. на модерацию
            </button>
          </div>
        )}
      {!enabled && (
        <small>
          Отправка на модерацию отключена на этом сервере; доступна только
          проверка.
        </small>
      )}
      {action && (
        <div className="direct-budget-preview-result" role="status">
          <strong>
            {action.status === "succeeded"
              ? "Объявление отправлено на проверку"
              : action.status === "needs_reconciliation"
                ? "Ответ требует сверки"
                : action.status === "failed_no_write"
                  ? "Команда не отправлялась"
                  : "Действие выполняется"}
          </strong>
          <small>
            {action.status === "succeeded"
              ? "Яндекс принял объявление. Это ещё не означает, что оно одобрено. Показы не запущены · "
              : "Показы не возобновлялись · "}
            {new Date(action.updatedAt).toLocaleString("ru-RU")}
          </small>
          {action.status === "succeeded" && (
            <button
              type="button"
              className="secondary"
              aria-busy={decisionPending}
              disabled={pending || decisionPending || busy}
              onClick={checkDecision}
            >
              {decisionPending || busy
                ? "Проверяем решение…"
                : "Проверить решение Яндекса"}
            </button>
          )}
          {action.status === "needs_reconciliation" && (
            <button
              type="button"
              className="secondary"
              disabled={pending}
              onClick={reconcile}
            >
              Сверить объявления без повторной отправки
            </button>
          )}
        </div>
      )}
      {error && <small role="alert">{error}</small>}
    </div>
  );
}

type MarkingCheck = {
  checkedAt: string;
  hasTaxId: boolean;
  hasName: boolean;
  findings: string[];
  basicFieldsPresent: boolean;
  manualReviewRequired: true;
  launchAuthorized: false;
  externalWrites: 0;
};

function MarkingCheckCard({
  businessId,
  changeId,
}: {
  businessId: string;
  changeId: string;
}) {
  const [check, setCheck] = useState<MarkingCheck | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function inspect() {
    setPending(true);
    setError("");
    try {
      setCheck(
        (await api(
          `/businesses/${businessId}/direct/${changeId}/marking-check`,
        )) as MarkingCheck,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось проверить данные рекламодателя.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="direct-marking-check">
      <b>Данные для маркировки</b>
      <p>
        Яндекс отмечает объявления и выдаёт ERID после заполнения данных
        конечного рекламодателя в Директе. Проверка ниже только читает основные
        поля кабинета.
      </p>
      <button
        type="button"
        className="secondary"
        disabled={pending}
        onClick={inspect}
      >
        {pending ? "Проверяем…" : "Проверить данные рекламодателя"}
      </button>
      {error && <small role="alert">{error}</small>}
      {check && (
        <div className="direct-budget-preview-result" role="status">
          <strong>
            {check.basicFieldsPresent
              ? "Основные поля найдены"
              : "Данные требуют заполнения"}
          </strong>
          <small>
            ИНН: {check.hasTaxId ? "найден" : "не найден"} · имя/название:{" "}
            {check.hasName ? "найдено" : "не найдено"} ·{" "}
            {new Date(check.checkedAt).toLocaleString("ru-RU")}
          </small>
          {check.findings.length > 0 && (
            <ul>
              {check.findings.map((finding) => (
                <li key={finding}>{finding}</li>
              ))}
            </ul>
          )}
          <small>
            Это не подтверждение юридической корректности и не разрешение
            запуска. Реквизиты не сохраняются в «Ритме».
          </small>
        </div>
      )}
      <a
        href="https://yandex.ru/support/direct/ru/technologies-and-services/ad-labelingl"
        target="_blank"
        rel="noreferrer"
      >
        Как заполнить данные в Директе <ExternalLink size={13} />
      </a>
    </div>
  );
}

function BudgetPreviewForm({
  businessId,
  changeId,
  ownerLimit,
  enabled,
  onChanged,
}: {
  businessId: string;
  changeId: string;
  ownerLimit: number;
  enabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const [rubles, setRubles] = useState(Math.round(ownerLimit / 100));
  const [preview, setPreview] = useState<DirectBudgetPreview | null>(null);
  const [action, setAction] = useState<DirectBudgetAction | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [rollbackConfirmed, setRollbackConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const keyName = `ritm:budget:${businessId}:${changeId}`;
  useEffect(() => {
    void api(`/businesses/${businessId}/direct/${changeId}/budget-actions`)
      .then((rows) => setAction((rows as DirectBudgetAction[])[0] || null))
      .catch(() => {});
  }, [businessId, changeId]);
  async function submitPreview(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    setPreview(null);
    try {
      const result = await api(
        `/businesses/${businessId}/direct/${changeId}/budget-preview`,
        { proposedLimitKopecks: Math.round(rubles * 100) },
      );
      setPreview(result as DirectBudgetPreview);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось рассчитать лимит.",
      );
    } finally {
      setPending(false);
    }
  }
  async function applyLimit() {
    if (!preview || preview.remoteLimitKopecks === null) return;
    setPending(true);
    setError("");
    const requestKey = safeStorage.getItem(keyName) || crypto.randomUUID();
    safeStorage.setItem(keyName, requestKey);
    try {
      const result = (await api(
        `/businesses/${businessId}/direct/${changeId}/budget-limit`,
        {
          proposedLimitKopecks: preview.proposedLimitKopecks,
          confirmCampaignId: preview.campaignId,
          confirmPreviousLimitKopecks: preview.remoteLimitKopecks,
          budgetConfirmed: confirmed,
        },
        "POST",
        requestKey,
      )) as DirectBudgetAction;
      setAction(result);
      if (
        ["succeeded", "failed_no_write", "not_applied"].includes(result.status)
      )
        safeStorage.removeItem(keyName);
      if (result.status === "succeeded") await onChanged();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось изменить лимит.",
      );
    } finally {
      setPending(false);
    }
  }
  async function reconcile() {
    if (!action) return;
    setPending(true);
    setError("");
    try {
      const result = (await api(
        `/businesses/${businessId}/direct/${changeId}/budget-limit/${action.id}/inspect`,
        {},
      )) as DirectBudgetAction;
      setAction(result);
      if (result.status !== "needs_reconciliation")
        safeStorage.removeItem(keyName);
      await onChanged();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось сверить лимит.",
      );
    } finally {
      setPending(false);
    }
  }
  async function rollbackLimit() {
    if (!action || action.status !== "succeeded") return;
    setPending(true);
    setError("");
    const rollbackKeyName = `ritm:budget-rollback:${businessId}:${action.id}`;
    const requestKey =
      safeStorage.getItem(rollbackKeyName) || crypto.randomUUID();
    safeStorage.setItem(rollbackKeyName, requestKey);
    try {
      const result = (await api(
        `/businesses/${businessId}/direct/${changeId}/budget-limit/${action.id}/rollback`,
        {
          spendConfirmed: rollbackConfirmed,
          confirmCurrentLimitKopecks: action.requestedLimitKopecks,
          confirmRestoredLimitKopecks: action.previousLimitKopecks,
        },
        "POST",
        requestKey,
      )) as DirectBudgetAction;
      setAction(result);
      if (
        result.rollback &&
        ["succeeded", "failed_no_write", "not_applied"].includes(
          result.rollback.status,
        )
      )
        safeStorage.removeItem(rollbackKeyName);
      if (result.rollback?.status === "succeeded") await onChanged();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось восстановить исходный лимит.",
      );
    } finally {
      setPending(false);
    }
  }
  async function reconcileRollback() {
    if (!action) return;
    setPending(true);
    setError("");
    const rollbackKeyName = `ritm:budget-rollback:${businessId}:${action.id}`;
    try {
      const result = (await api(
        `/businesses/${businessId}/direct/${changeId}/budget-limit/${action.id}/rollback/inspect`,
        {},
      )) as DirectBudgetAction;
      setAction(result);
      if (result.rollback?.status !== "needs_reconciliation")
        safeStorage.removeItem(rollbackKeyName);
      await onChanged();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сверить восстановление лимита.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <form noValidate className="direct-budget-preview" onSubmit={submitPreview}>
      <label>
        Предварительный расчёт нового лимита, ₽
        <input
          type="number"
          min="1"
          max={Math.floor(ownerLimit / 100)}
          step="1"
          value={rubles}
          onChange={(event) => {
            setRubles(Number(event.target.value));
            setPreview(null);
          }}
          required
        />
      </label>
      <button
        className="secondary"
        disabled={pending || rubles <= 0 || rubles * 100 > ownerLimit}
      >
        {pending ? "Считаем…" : "Оценить изменение без отправки"}
      </button>
      {error && <p role="alert">{error}</p>}
      {preview && (
        <div role="status" className="direct-budget-preview-result">
          <b>
            Лимит в Директе: {money(preview.remoteLimitKopecks)} → предложено{" "}
            {money(preview.proposedLimitKopecks)}
          </b>
          <small>
            Утверждённый максимум: {money(preview.ownerLimitKopecks)} ·
            известный расход по сохранённому отчёту:{" "}
            {money(preview.knownReportedSpentKopecks)}
          </small>
          {preview.blockers.length > 0 && (
            <ul>
              {preview.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          )}
          <small>{preview.notice} В Директ ничего не отправлено.</small>
          {enabled && preview.preliminaryChecksPassed && !action && (
            <div className="direct-budget-confirm">
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />{" "}
                Подтверждаю уменьшение лимита до{" "}
                {money(preview.proposedLimitKopecks)}. Вернуть можно только
                исходный утверждённый лимит.
              </label>
              <button
                type="button"
                className="primary"
                disabled={pending || !confirmed}
                onClick={applyLimit}
              >
                {pending ? "Проверяем…" : "Уменьшить лимит"}
              </button>
            </div>
          )}
          {!enabled && preview.preliminaryChecksPassed && (
            <small>
              Изменение лимита отключено на сервере. Предпросмотр остаётся
              доступным.
            </small>
          )}
        </div>
      )}
      {action && (
        <div role="status" className="direct-budget-preview-result">
          <b>
            {action.status === "succeeded"
              ? "Новый лимит подтверждён Директом"
              : action.status === "needs_reconciliation"
                ? "Результат требует сверки"
                : action.status === "not_applied"
                  ? "Лимит не изменился"
                  : action.status === "failed_no_write"
                    ? "Команда не отправлялась"
                    : "Изменение выполняется"}
          </b>
          <small>
            Кампания №{action.campaignId} · {money(action.previousLimitKopecks)}
            {" → "}
            {money(action.requestedLimitKopecks)} · подтверждено{" "}
            {money(action.confirmedLimitKopecks)}
          </small>
          {action.status === "needs_reconciliation" && (
            <button
              type="button"
              className="secondary"
              disabled={pending}
              onClick={reconcile}
            >
              Сверить без повторной отправки
            </button>
          )}
          {action.status === "succeeded" && !action.rollback && (
            <div className="direct-budget-confirm">
              <label>
                <input
                  type="checkbox"
                  checked={rollbackConfirmed}
                  onChange={(event) =>
                    setRollbackConfirmed(event.target.checked)
                  }
                />{" "}
                Подтверждаю возврат исходного лимита{" "}
                {money(action.previousLimitKopecks)}. Это снова разрешит
                расходовать остаток утверждённого бюджета, но не увеличит его
                максимум.
              </label>
              <button
                type="button"
                className="secondary"
                disabled={pending || !rollbackConfirmed}
                onClick={rollbackLimit}
              >
                {pending ? "Проверяем…" : "Вернуть исходный лимит"}
              </button>
            </div>
          )}
          {action.rollback?.status === "succeeded" && (
            <small>
              Исходный лимит {money(action.previousLimitKopecks)} восстановлен и
              подтверждён чтением Директа.
            </small>
          )}
          {action.rollback?.status === "not_applied" && (
            <small>Исходный лимит не восстановлен — расход не изменился.</small>
          )}
          {action.rollback?.status === "failed_no_write" && (
            <small>Восстановление отменено до отправки команды.</small>
          )}
          {action.rollback?.status === "needs_reconciliation" && (
            <button
              type="button"
              className="secondary"
              disabled={pending}
              onClick={reconcileRollback}
            >
              Сверить восстановление без повторной отправки
            </button>
          )}
        </div>
      )}
    </form>
  );
}

function DirectPlanBuilder({
  ws,
  busy,
  navigate,
  prepareAiPlan,
  submit,
  preflight,
  confirmPlan,
  executePlan,
  inspectExecution,
  suspendCampaign,
  inspectLifecycle,
  checkBudget,
  inspectControl,
  reviewShadow,
  refresh,
}: {
  ws: Workspace;
  busy: boolean;
  navigate: (page: string) => void;
  prepareAiPlan: () => void;
  submit: (plan: DirectPlan) => void;
  preflight: (id: string) => void;
  confirmPlan: (id: string, planFingerprint: string) => void;
  executePlan: (
    id: string,
    planFingerprint: string,
    name: string,
    budget: number,
  ) => void;
  inspectExecution: (id: string) => void;
  suspendCampaign: (id: string, name: string, campaignId: number) => void;
  inspectLifecycle: (id: string, actionId: string) => void;
  checkBudget: (id: string) => void;
  inspectControl: (id: string) => Promise<boolean> | boolean | void;
  reviewShadow: (id: string) => void;
  refresh: () => Promise<void>;
}) {
  const linked = ws.connections.find((c) => c.provider === "yandex"),
    aiPlan = ws.state.aiPlan,
    firstCreative = ws.state.creatives[0],
    draftKey = `ritm:direct-plan:${ws.id}`,
    savedDraft = (() => {
      try {
        return JSON.parse(safeStorage.getItem(draftKey) || "{}") as Record<
          string,
          string | number
        >;
      } catch {
        return {};
      }
    })(),
    savedPeriod = nextCampaignPeriod(
      String(savedDraft.periodStart || ""),
      String(savedDraft.periodEnd || ""),
    ),
    savedPeriodIsStale =
      !!savedDraft.periodStart &&
      String(savedDraft.periodStart) <= moscowDateAfter(0),
    [step, setStep] = useState(0),
    [login, setLogin] = useState(
      String(savedDraft.login || linked?.clients[0]?.Login || ""),
    ),
    [campaignName, setCampaignName] = useState(
      String(savedDraft.campaignName || `${ws.state.name} · Поиск`),
    ),
    [website, setWebsite] = useState(
      String(savedDraft.website || ws.state.website),
    ),
    [audience, setAudience] = useState(
      String(
        savedDraft.audience ||
          `Люди в городе ${ws.state.city}, которым нужна услуга «${ws.state.service}»`,
      ),
    ),
    [regions, setRegions] = useState(
      String(
        savedDraft.regions ||
          (/екатеринбург/i.test(ws.state.city) ? "54" : "0"),
      ),
    ),
    [budget, setBudget] = useState(
      Number(savedDraft.budget || Math.round(ws.state.budget / 100)),
    ),
    [targetCpa, setTargetCpa] = useState(
      Number(savedDraft.targetCpa || Math.round(ws.state.targetCpa / 100)),
    ),
    [periodStart, setPeriodStart] = useState(
      savedPeriodIsStale
        ? savedPeriod.start
        : String(savedDraft.periodStart || savedPeriod.start),
    ),
    [periodEnd, setPeriodEnd] = useState(
      savedPeriodIsStale
        ? savedPeriod.end
        : String(savedDraft.periodEnd || savedPeriod.end),
    ),
    [title, setTitle] = useState(
      String(
        savedDraft.title || firstCreative?.title || ws.state.service,
      ).slice(0, 56),
    ),
    [adText, setAdText] = useState(
      String(
        savedDraft.adText || firstCreative?.text || ws.state.benefit,
      ).slice(0, 81),
    ),
    [creativeAssetId, setCreativeAssetId] = useState(
      String(
        savedDraft.creativeAssetId ||
          ws.creativeImages.find(
            (image) =>
              image.approvedAt &&
              image.directUploads.some((upload) => upload.login === login),
          )?.id ||
          "",
      ),
    ),
    [keywords, setKeywords] = useState(
      String(
        savedDraft.keywords ||
          `${ws.state.service} ${ws.state.city}\n${ws.state.service} рядом\n${ws.state.category} ${ws.state.city}`,
      ),
    ),
    [periodRenewed, setPeriodRenewed] = useState(savedPeriodIsStale);
  const availableCreativeImages = ws.creativeImages.filter(
    (image) =>
      image.approvedAt &&
      image.directUploads.some((upload) => upload.login === login),
  );
  useEffect(() => {
    if (availableCreativeImages.some((image) => image.id === creativeAssetId))
      return;
    setCreativeAssetId(availableCreativeImages[0]?.id || "");
  }, [login, ws.creativeImages]);
  useEffect(() => {
    if (!aiPlan) return;
    const firstAd = aiPlan.plan.ads[0];
    setAudience(aiPlan.plan.audiences.map((item) => item.name).join("; "));
    setKeywords(aiPlan.plan.keywords.join("\n"));
    setTitle(firstAd?.title || ws.state.service);
    setAdText(firstAd?.text || ws.state.benefit);
    setCampaignName(
      `${ws.state.name} · ${aiPlan.plan.channels.includes("search") ? "Поиск" : "Реклама"}`.slice(
        0,
        255,
      ),
    );
  }, [aiPlan?.inputHash, ws.state.name, ws.state.service, ws.state.benefit]);
  const planRef = useRef<HTMLFormElement>(null);
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const changes = ws.directChanges || [];
  function renewDraftPeriod() {
    const next = nextCampaignPeriod(periodStart, periodEnd);
    setPeriodStart(next.start);
    setPeriodEnd(next.end);
    setPeriodRenewed(true);
  }
  useEffect(() => {
    if (periodStart <= moscowDateAfter(0)) renewDraftPeriod();
  }, [periodStart, periodEnd]);
  const hasQueuedChange = changes.some((change) =>
    ["pending", "running"].includes(change.status),
  );
  const hasExecutedChange = changes.some(
    (change) => change.execution?.status === "succeeded",
  );
  useEffect(() => {
    if (!hasQueuedChange) return;
    const timer = window.setInterval(
      () => void refresh().catch(() => {}),
      2500,
    );
    return () => window.clearInterval(timer);
  }, [hasQueuedChange, ws.id]);
  useEffect(() => {
    if (!hasExecutedChange) return;
    const timer = window.setInterval(
      () => void refresh().catch(() => {}),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, [hasExecutedChange, ws.id]);
  const steps = [
    ["Сайт и кабинет", "Куда вести людей"],
    ["Кому показать", "Город и бюджет"],
    ["Объявление", "Что увидят будущие клиенты"],
    ["Проверка", "Подготовка к запуску"],
  ];
  const canContinue =
    step === 0
      ? Boolean(login && campaignName.trim().length > 1 && website.trim())
      : step === 1
        ? Boolean(
            regions.trim() &&
            audience.trim().length > 1 &&
            budget > 0 &&
            targetCpa > 0 &&
            periodStart > moscowDateAfter(0) &&
            Number.isInteger(daysBetween(periodStart, periodEnd)) &&
            daysBetween(periodStart, periodEnd) >= 1 &&
            daysBetween(periodStart, periodEnd) <= 90,
          )
        : step === 2
          ? Boolean(
              title.trim().length > 1 &&
              adText.trim().length > 1 &&
              keywords.trim(),
            )
          : true;
  useEffect(() => {
    safeStorage.setItem(
      draftKey,
      JSON.stringify({
        login,
        campaignName,
        website,
        audience,
        regions,
        budget,
        targetCpa,
        periodStart,
        periodEnd,
        title,
        adText,
        creativeAssetId,
        keywords,
      }),
    );
  }, [
    draftKey,
    login,
    campaignName,
    website,
    audience,
    regions,
    budget,
    targetCpa,
    periodStart,
    periodEnd,
    title,
    adText,
    creativeAssetId,
    keywords,
  ]);
  function goToStep(nextStep: number) {
    setStep(nextStep);
    requestAnimationFrame(() => {
      planRef.current?.scrollIntoView({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    });
  }
  function send(e: React.FormEvent) {
    e.preventDefault();
    const regionIds = regions
        .split(",")
        .map((v) => Number(v.trim()))
        .filter(Number.isInteger),
      phrases = keywords
        .split("\n")
        .map((v) => v.trim())
        .filter(Boolean);
    submit({
      login,
      campaignName,
      website,
      audience,
      regionIds,
      budget: Math.round(budget * 100),
      targetCpa: Math.round(targetCpa * 100),
      periodStart,
      periodEnd,
      ...(ws.state.counterId ? { counterId: ws.state.counterId } : {}),
      ...(ws.state.goalId ? { goalId: ws.state.goalId } : {}),
      ...(creativeAssetId ? { creativeAssetId } : {}),
      ads: aiPlan
        ? aiPlan.plan.ads.map((ad) => ({
            title: ad.title,
            text: ad.text,
            href: website,
          }))
        : [{ title, text: adText, href: website }],
      keywords: aiPlan ? aiPlan.plan.keywords : phrases,
      negativeKeywords: aiPlan ? aiPlan.plan.negativeKeywords : [],
    });
  }
  if (!aiPlan)
    return (
      <div className="direct-layout">
        <section className="card ai-plan-card ai-plan-pending">
          <div className="ai-plan-card-heading">
            <div className="ai-plan-mark" aria-hidden="true">
              <Sparkles size={18} />
            </div>
            <div>
              <span className="eyebrow">ПОДГОТОВКА ЗАПУСКА</span>
              <h2>Ритм соберёт первый план рекламы</h2>
              <p>
                Рита сама предложит аудитории, объявления и распределение
                бюджета. Ручная настройка ставок и ключевых фраз не требуется.
              </p>
            </div>
            <button
              type="button"
              className="primary ai-plan-button"
              disabled={busy}
              onClick={prepareAiPlan}
            >
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Sparkles size={16} />
              )}
              {busy ? "Собираем план…" : "Подготовить план"}
            </button>
          </div>
        </section>
      </div>
    );
  return (
    <div className="direct-layout">
      <section className="card ai-plan-card">
        <div className="ai-plan-card-heading">
          <div className="ai-plan-mark" aria-hidden="true">
            <Sparkles size={18} />
          </div>
          <div>
            <span className="eyebrow">ПОДГОТОВКА ЗАПУСКА</span>
            <h2>
              {aiPlan
                ? "План готов к проверке"
                : "Сначала расскажите о бизнесе"}
            </h2>
            <p>
              {aiPlan
                ? aiPlan.plan.summary
                : "Подберём аудиторию, варианты объявлений и стартовое распределение бюджета. Вы не настраиваете ставки и ключевые фразы вручную."}
            </p>
          </div>
          <button
            type="button"
            className="primary ai-plan-button"
            disabled={busy}
            onClick={prepareAiPlan}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Sparkles size={16} />
            )}
            {aiPlan ? "Обновить план" : "Подготовить план"}
          </button>
        </div>
        {aiPlan && (
          <div className="ai-plan-summary">
            <div>
              <span>Кому покажем</span>
              <b>
                {aiPlan.plan.audiences.map((item) => item.name).join(" · ")}
              </b>
            </div>
            <div>
              <span>Где начнём</span>
              <b>
                {aiPlan.plan.channels
                  .map((item) =>
                    item === "search" ? "Поиск" : "Рекламная сеть",
                  )
                  .join(" + ")}
              </b>
            </div>
            <div>
              <span>Проверим</span>
              <b>
                {aiPlan.plan.abHypotheses[0]?.hypothesis || "Новую гипотезу"}
              </b>
            </div>
            <div>
              <span>План подготовил</span>
              <b>Ритм</b>
            </div>
          </div>
        )}
        {aiPlan?.plan.warnings.length ? (
          <p className="ai-plan-warning">{aiPlan.plan.warnings.join(" ")}</p>
        ) : null}
      </section>
      {aiPlan ? (
        <form className="card direct-plan" noValidate onSubmit={send}>
          <div className="card-heading direct-heading">
            <div>
              <span className="eyebrow">План перед проверкой</span>
              <h2>Реклама без ручной настройки</h2>
              <p>
                Мы подготовили варианты объявлений, аудитории и распределение
                бюджета. Перед отправкой проверим подключение и посадочную
                страницу.
              </p>
            </div>
            <div className="draft-state">
              <Check size={14} /> План сохранён
            </div>
          </div>
          <div className="ai-plan-summary">
            <div>
              <span>Ваш бизнес</span>
              <b>{ws.state.name}</b>
            </div>
            <div>
              <span>Где покажем</span>
              <b>{ws.state.city}</b>
            </div>
            <div>
              <span>Бюджет на период</span>
              <b>{money(ws.state.budget)}</b>
            </div>
            <div>
              <span>Варианты объявлений</span>
              <b>{aiPlan.plan.ads.length}</b>
            </div>
          </div>
          {periodRenewed && (
            <div className="period-renewed-note" role="status">
              <Clock3 size={17} />
              <span>
                Срок сохранённого черновика прошёл. Для нового плана выбран
                период {date(periodStart)} — {date(periodEnd)}.
              </span>
            </div>
          )}
          <div className="plan-review-grid">
            <section className="plan-review-section">
              <div className="plan-review-heading">
                <span className="plan-review-icon">
                  <Megaphone size={17} />
                </span>
                <div>
                  <small>Аудитория</small>
                  <h3>Кому покажем рекламу</h3>
                </div>
              </div>
              <div className="plan-audience-list">
                {aiPlan.plan.audiences.map((item) => (
                  <article key={`${item.name}-${item.need}`}>
                    <b>{item.name}</b>
                    <p>{item.need}</p>
                  </article>
                ))}
              </div>
              <p className="plan-location">
                <span>География</span>
                {ws.state.city}
              </p>
            </section>
            <section className="plan-review-section plan-ads-section">
              <div className="plan-review-heading">
                <span className="plan-review-icon">
                  <FileText size={17} />
                </span>
                <div>
                  <small>Объявления</small>
                  <h3>Что увидят потенциальные клиенты</h3>
                </div>
              </div>
              <div className="plan-ad-list">
                {aiPlan.plan.ads.map((ad, index) => (
                  <article key={`${ad.title}-${index}`}>
                    <span>
                      Вариант {index + 1} · {ad.angle}
                    </span>
                    <b>{ad.title}</b>
                    <p>{ad.text}</p>
                  </article>
                ))}
              </div>
              {availableCreativeImages.length ? (
                <label className="plan-creative-choice">
                  Изображение для объявлений
                  <select
                    value={creativeAssetId}
                    onChange={(event) => setCreativeAssetId(event.target.value)}
                  >
                    {availableCreativeImages.map((image, index) => (
                      <option key={image.id} value={image.id}>
                        Согласованный вариант {index + 1}
                      </option>
                    ))}
                  </select>
                  <span>
                    Изображение уже добавлено в кабинет и будет использовано во
                    всех вариантах этого плана.
                  </span>
                </label>
              ) : (
                <button
                  type="button"
                  className="text-button plan-creative-link"
                  onClick={() => navigate("creatives")}
                >
                  <Images size={16} /> Подготовить изображение для рекламы
                </button>
              )}
            </section>
            <section className="plan-review-section">
              <div className="plan-review-heading">
                <span className="plan-review-icon">
                  <Wallet size={17} />
                </span>
                <div>
                  <small>Бюджет</small>
                  <h3>Как распределим лимит</h3>
                </div>
              </div>
              <strong className="plan-budget-total">
                {money(ws.state.budget)}
              </strong>
              <div className="plan-budget-list">
                {aiPlan.plan.budgetAllocation.map((item) => (
                  <div key={item.channel}>
                    <p>
                      <span>
                        {item.channel === "search"
                          ? "Поиск Яндекса"
                          : "Рекламная сеть"}
                      </span>
                      <b>{item.percent}%</b>
                    </p>
                    <span className="plan-budget-track">
                      <i style={{ width: `${item.percent}%` }} />
                    </span>
                  </div>
                ))}
              </div>
              <p className="plan-budget-note">
                Общий лимит не будет превышен. До подтверждения ничего не
                отправляется в Директ.
              </p>
            </section>
          </div>
          <div className="wizard-tip">
            <ShieldCheck size={17} />
            <span>
              Вы не задаёте ставки, ключевые фразы или настройки кабинета.
              Сервис использует их только внутри проверяемого плана.
            </span>
          </div>
          <div className="direct-actions">
            <button
              className="primary"
              disabled={busy || !linked || !website.trim()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <ShieldCheck size={16} />
              )}
              Проверить и подготовить запуск
            </button>
          </div>
          {!linked && (
            <p className="info-note">
              Сначала подключите Яндекс Директ — без него Ритм не сможет
              подготовить запуск.
            </p>
          )}
          {!website.trim() && (
            <p className="info-note">
              Выберите страницу, куда придёт человек после объявления. Если
              своего сайта нет, создайте бесплатную страницу в Яндексе.
            </p>
          )}
        </form>
      ) : (
        <form
          noValidate
          ref={planRef}
          className="card direct-plan"
          onSubmit={(event) => {
            if (step < steps.length - 1) {
              event.preventDefault();
              if (canContinue) goToStep(step + 1);
              return;
            }
            send(event);
          }}
        >
          <div className="card-heading direct-heading">
            <div>
              <h2>{aiPlan ? "План кампании" : "Новый план кампании"}</h2>
              <p>
                {aiPlan
                  ? "Данные подставлены из стратегии. При необходимости их можно уточнить перед проверкой."
                  : "Отдельный черновик для будущей кампании. Изменения здесь не меняют уже созданные кампании в Директе."}
              </p>
            </div>
            <div className="draft-state">
              <Check size={14} /> Черновик сохранён
            </div>
          </div>
          <div className="wizard-steps" aria-label="Шаги создания кампании">
            {steps.map(([name, description], index) => (
              <button
                type="button"
                key={name}
                className={
                  index === step ? "current" : index < step ? "complete" : ""
                }
                aria-current={index === step ? "step" : undefined}
                disabled={index > step}
                onClick={() => index <= step && goToStep(index)}
              >
                <span>{index < step ? <Check size={14} /> : index + 1}</span>
                <div>
                  <b>{name}</b>
                  <small>{description}</small>
                </div>
              </button>
            ))}
          </div>
          <div className="wizard-panel">
            <div className="wizard-panel-heading">
              <span>
                Шаг {step + 1} из {steps.length}
              </span>
              <h3>{steps[step][0]}</h3>
            </div>
            {step === 0 && (
              <div className="direct-form-grid">
                <label>
                  Кабинет Директа
                  <select
                    value={login}
                    onChange={(e) => setLogin(e.target.value)}
                    required
                  >
                    <option value="">Выберите кабинет</option>
                    {(linked?.clients || []).map((client) => (
                      <option key={client.Login} value={client.Login}>
                        {client.Login}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Название кампании
                  <input
                    value={campaignName}
                    onChange={(e) => setCampaignName(e.target.value)}
                    required
                    minLength={2}
                    maxLength={255}
                  />
                </label>
                <label className="wide">
                  Сайт или посадочная страница
                  <input
                    type="url"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="https://example.ru"
                    required
                  />
                </label>
                <div className="wizard-tip wide">
                  <ShieldCheck size={17} />
                  <span>
                    На этом этапе ничего не отправляется в Яндекс. Мы только
                    подготовим и проверим структуру плана.
                  </span>
                </div>
              </div>
            )}
            {step === 1 && (
              <div className="direct-form-grid">
                <label>
                  География · ID регионов через запятую
                  <input
                    value={regions}
                    onChange={(e) => setRegions(e.target.value)}
                    pattern="-?\d+(\s*,\s*-?\d+)*"
                    required
                  />
                  <small>Екатеринбург — 54; 0 — все регионы.</small>
                </label>
                <label>
                  Аудитория
                  <textarea
                    className="resize-none"
                    value={audience}
                    onChange={(e) => setAudience(e.target.value)}
                    required
                    minLength={2}
                    maxLength={500}
                  />
                </label>
                <label>
                  Бюджет на период, ₽
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={budget}
                    onChange={(e) => setBudget(Number(e.target.value))}
                    required
                  />
                </label>
                <label>
                  Ориентир цены обращения, ₽
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={targetCpa}
                    onChange={(e) => setTargetCpa(Number(e.target.value))}
                    required
                  />
                  <small>
                    Сохраняется в плане для аналитики; ставка Директа сейчас им
                    не управляется.
                  </small>
                </label>
                <label>
                  Начало периода
                  <input
                    type="date"
                    min={moscowDateAfter(1)}
                    value={periodStart}
                    onChange={(e) => setPeriodStart(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Конец периода
                  <input
                    type="date"
                    min={periodStart}
                    value={periodEnd}
                    onChange={(e) => setPeriodEnd(e.target.value)}
                    required
                  />
                  <small>
                    Период от 1 до 90 дней. Автопродление отключено.
                  </small>
                </label>
              </div>
            )}
            {step === 2 && (
              <div className="direct-form-grid">
                <label className="wide">
                  Заголовок объявления
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    minLength={2}
                    maxLength={56}
                    required
                  />
                  <small>{title.length}/56</small>
                </label>
                <label className="wide">
                  Текст объявления
                  <textarea
                    className="resize-none"
                    value={adText}
                    onChange={(e) => setAdText(e.target.value)}
                    minLength={2}
                    maxLength={81}
                    required
                  />
                  <small>{adText.length}/81</small>
                </label>
                <label className="wide">
                  Ключевые фразы · по одной в строке
                  <textarea
                    className="resize-none"
                    rows={5}
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                    required
                  />
                </label>
                <div className="ad-copy-preview wide">
                  <small>Предпросмотр текстового объявления</small>
                  <b>{title || "Заголовок объявления"}</b>
                  <p>{adText || "Текст объявления появится здесь."}</p>
                  <span>{website || "Адрес посадочной страницы"}</span>
                </div>
              </div>
            )}
            {step === 3 && (
              <div className="wizard-review">
                <div>
                  <span>Кабинет</span>
                  <b>{login || "Не выбран"}</b>
                </div>
                <div>
                  <span>География</span>
                  <b>{regions || "Не указана"}</b>
                </div>
                <div>
                  <span>Бюджет</span>
                  <b>{budget.toLocaleString("ru-RU")} ₽</b>
                </div>
                <div>
                  <span>Период</span>
                  <b>
                    {periodStart} — {periodEnd}
                  </b>
                </div>
                <div>
                  <span>Объявления</span>
                  <b>1 текстовое</b>
                </div>
                <div>
                  <span>Ключевые фразы</span>
                  <b>
                    {
                      keywords.split("\n").filter((value) => value.trim())
                        .length
                    }
                  </b>
                </div>
                <div className="wizard-safety">
                  <ShieldCheck size={19} />
                  <span>
                    Ритм только подготовит и проверит план. Реклама не
                    запускается, деньги не списываются.
                  </span>
                </div>
              </div>
            )}
          </div>
          <div className="direct-actions">
            <button
              type="button"
              className="secondary"
              disabled={step === 0}
              onClick={() => goToStep(Math.max(0, step - 1))}
            >
              <ChevronLeft size={16} /> Назад
            </button>
            {step < steps.length - 1 ? (
              <button className="primary" disabled={!canContinue}>
                Продолжить <ChevronRight size={16} />
              </button>
            ) : (
              <button className="primary" disabled={busy || !linked}>
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <ShieldCheck size={16} />
                )}
                Проверить и подготовить запуск
              </button>
            )}
          </div>
          {!linked && (
            <p className="info-note">
              Сначала подключите Яндекс Директ — без него нельзя подготовить
              запуск.
            </p>
          )}
        </form>
      )}
      <aside className="card direct-preview" aria-live="polite">
        <div className="preview-heading">
          <div>
            <small>Перед запуском</small>
            <h2>{campaignName || "Новая кампания"}</h2>
          </div>
          <Badge tone="amber">ПОКА БЕЗ ЗАПУСКА</Badge>
        </div>
        <dl>
          <div>
            <dt>Режим</dt>
            <dd>Ритм проверяет и предлагает</dd>
          </div>
          <div>
            <dt>Регион</dt>
            <dd>{aiPlan ? ws.state.city : regions || "—"}</dd>
          </div>
          <div>
            <dt>Объявлений</dt>
            <dd>{aiPlan ? aiPlan.plan.ads.length : 1}</dd>
          </div>
          <div>
            <dt>Ключевых фраз</dt>
            <dd>
              {aiPlan
                ? "Подберёт сервис"
                : keywords.split("\n").filter((v) => v.trim()).length}
            </dd>
          </div>
          <div>
            <dt>Бюджет нового плана</dt>
            <dd>
              {aiPlan
                ? money(ws.state.budget)
                : `${budget.toLocaleString("ru-RU")} ₽`}
            </dd>
          </div>
          <div>
            <dt>Период</dt>
            <dd>
              {periodStart} — {periodEnd}
            </dd>
          </div>
        </dl>
        <div className="queue-list">
          <h3>Планы и созданные кампании</h3>
          {!changes.length && <p className="muted">План ещё не проверяли.</p>}
          {changes.map((change) => (
            <article key={change.id}>
              <div className="direct-existing-summary">
                <small>
                  {change.execution?.status === "succeeded"
                    ? "Создана в Директе · текущее состояние сверяйте ниже"
                    : "Ранее сохранённый план"}
                </small>
                <strong>
                  {change.plan?.campaignName || "План без названия"}
                </strong>
                <span>
                  {change.plan?.budget
                    ? `Лимит этого плана: ${money(change.plan.budget)}`
                    : "Лимит не указан"}
                </span>
              </div>
              <Badge
                tone={
                  change.status === "succeeded"
                    ? "green"
                    : change.status === "failed"
                      ? "amber"
                      : "gray"
                }
              >
                {change.status === "succeeded"
                  ? "Проверено"
                  : change.status === "failed"
                    ? "Нужна проверка"
                    : "Готовим план"}
              </Badge>
              <b>
                {change.summary.ads} объявл. · {change.summary.keywords} фраз
              </b>
              {change.error && <p>{change.error}</p>}
              <details className="direct-command-review">
                <summary>Технические детали</summary>
                <p>
                  Кабинет: {change.plan?.login || "—"} · период:{" "}
                  {change.plan?.periodStart || "—"} —{" "}
                  {change.plan?.periodEnd || "—"}
                </p>
                <ol>
                  {change.commands.map((command) => (
                    <li key={command.key}>
                      {command.service}.{command.method}
                    </li>
                  ))}
                </ol>
                <pre>
                  {JSON.stringify(
                    { plan: change.plan, commands: change.commands },
                    null,
                    2,
                  )}
                </pre>
                <p>
                  Эта проверка не отправляет команды. Создание кампании требует
                  отдельной проверки и подтверждения.
                </p>
              </details>
              {change.status === "succeeded" &&
                linked &&
                (change.plan?.periodStart || "") > moscowDateAfter(0) && (
                  <>
                    <button
                      type="button"
                      className="secondary direct-preflight-button"
                      disabled={busy}
                      onClick={() => preflight(change.id)}
                    >
                      <ShieldCheck size={15} />
                      {change.preflight
                        ? "Проверить ещё раз"
                        : "Проверить кабинет и риски"}
                    </button>
                    <p className="direct-check-explainer">
                      Эта проверка ничего не публикует. После неё нужно отдельно
                      подтвердить план.
                    </p>
                  </>
                )}
              {change.status === "succeeded" &&
                linked &&
                (change.plan?.periodStart || "") <= moscowDateAfter(0) && (
                  <div className="expired-plan-note" role="status">
                    <b>Срок этого плана уже прошёл</b>
                    <p>
                      Реклама по нему не создавалась. Для нового плана даты уже
                      обновлены выше.
                    </p>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={renewDraftPeriod}
                    >
                      Обновить период нового плана
                    </button>
                  </div>
                )}
              {change.preflight &&
                (change.plan?.periodStart || "") > moscowDateAfter(0) && (
                  <div className="direct-preflight-result" aria-live="polite">
                    <b>
                      {change.preflight.ready
                        ? "План прошёл предварительную проверку на указанное время"
                        : "До реального создания есть препятствия"}
                    </b>
                    <small>
                      Проверено{" "}
                      {new Date(change.preflight.checkedAt).toLocaleString(
                        "ru-RU",
                      )}
                      . Реклама пока не менялась.
                    </small>
                    {change.preflight.ready && (
                      <p className="direct-next-step">
                        Следующий шаг: подтвердите план ниже. Только после
                        отдельного согласия можно создать выключенный черновик
                        кампании.
                      </p>
                    )}
                    <ul>
                      {change.preflight.findings.map((finding) => (
                        <li key={finding.code} className={finding.severity}>
                          {finding.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              {change.preflight?.ready &&
                (change.plan?.periodStart || "") > moscowDateAfter(0) && (
                  <div
                    className="direct-approval"
                    data-direct-approval={change.id}
                  >
                    <b>Подтвердите подготовленный план</b>
                    <p className="direct-approval-explainer">
                      Подтверждение разрешает следующий шаг: создать выключенный
                      черновик кампании в Директе. Показы от этого не начнутся.
                    </p>
                    {Date.parse(change.preflight.checkedAt) + 10 * 60_000 <=
                      clock && (
                      <small>
                        Проверка устарела. Повторите её перед подтверждением.
                      </small>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={
                          reviewed ===
                          `${change.id}:${change.preflight.planFingerprint}`
                        }
                        onChange={(event) =>
                          setReviewed(
                            event.target.checked
                              ? `${change.id}:${change.preflight!.planFingerprint}`
                              : null,
                          )
                        }
                      />
                      Я просмотрел план и понимаю, что реклама пока не
                      запустится
                    </label>
                    <button
                      type="button"
                      className="secondary"
                      disabled={
                        busy ||
                        Date.parse(change.preflight.checkedAt) + 10 * 60_000 <=
                          clock ||
                        reviewed !==
                          `${change.id}:${change.preflight.planFingerprint}`
                      }
                      onClick={() =>
                        confirmPlan(
                          change.id,
                          change.preflight!.planFingerprint,
                        )
                      }
                    >
                      Подтвердить и перейти к черновику
                    </button>
                    {change.approval && !change.execution && (
                      <div className="direct-approval-state" role="status">
                        <b>
                          {Date.parse(change.approval.expiresAt) > clock
                            ? "План подтверждён. Реклама ещё не создана."
                            : "Подтверждение истекло. Реклама не создана."}
                        </b>
                        <small>
                          {Date.parse(change.approval.expiresAt) > clock
                            ? `Можно продолжить до ${new Date(change.approval.expiresAt).toLocaleString("ru-RU")}.`
                            : "Повторите проверку и подтвердите план заново."}
                        </small>
                      </div>
                    )}
                    {change.approval &&
                      !change.execution &&
                      ws.capabilities.directWritePilot && (
                        <button
                          type="button"
                          className="primary direct-execute-button"
                          disabled={
                            busy ||
                            Date.parse(change.approval.expiresAt) <= clock
                          }
                          onClick={() =>
                            executePlan(
                              change.id,
                              change.approval!.planFingerprint,
                              change.plan?.campaignName || "Новая кампания",
                              change.plan?.budget || 0,
                            )
                          }
                        >
                          Создать выключенный черновик
                        </button>
                      )}
                    {change.approval &&
                      !change.execution &&
                      !ws.capabilities.directWritePilot && (
                        <div className="direct-publish-blocked" role="status">
                          <b>
                            Реклама не появится в Директе из этого просмотра
                          </b>
                          <p>
                            Сервер работает в безопасном режиме: он умеет
                            подготовить и проверить план, но не создаёт
                            кампании. Для размещения нужен рабочий сервер с
                            отдельно включённым созданием кампаний.
                          </p>
                        </div>
                      )}
                  </div>
                )}
              {change.execution && (
                <div className="direct-execution-result" role="status">
                  <b>
                    {change.execution.status === "succeeded"
                      ? "Выключенная кампания создана и сверена"
                      : change.execution.status === "needs_reconciliation"
                        ? "Нужна сверка с Директом"
                        : "Создание выполняется"}
                  </b>
                  <small>
                    Сохранено шагов: {change.execution.calls.length} из 5
                    {change.execution.inflightKey
                      ? ` · последний шаг: ${change.execution.inflightKey}`
                      : ""}
                  </small>
                  {change.execution.status === "needs_reconciliation" && (
                    <>
                      <p>
                        Ответ внешнего API не подтвержден. Повтор заблокирован,
                        чтобы не создать дубликаты. Проверьте состояние кампании
                        в Директе.
                      </p>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => inspectExecution(change.id)}
                      >
                        Проверить сохранённые ID
                      </button>
                      {change.execution.reconciliation && (
                        <small>
                          Последняя сверка:{" "}
                          {change.execution.reconciliation.status === "mismatch"
                            ? "есть расхождение"
                            : "часть шагов ещё требует ручной проверки"}
                        </small>
                      )}
                    </>
                  )}
                </div>
              )}
              {change.execution?.status === "succeeded" && (
                <div className="direct-execution-result" role="status">
                  <b>Бюджет и расход</b>
                  <p>
                    {change.budgetCheck
                      ? change.budgetCheck.status === "matched"
                        ? `Лимит в Директе: ${money(change.budgetCheck.remote.limitKopecks)}. Период и автопродление совпадают с планом.`
                        : "Настройки кампании отличаются от утверждённого плана. Пока не меняйте лимит и не запускайте показы."
                      : "Проверьте фактический лимит в Директе перед управлением кампанией."}
                  </p>
                  {change.budgetCheck?.report ? (
                    <small>
                      Отчёт Директа:{" "}
                      {money(change.budgetCheck.report.reportedSpentKopecks)}
                      {change.budgetCheck.report.includeVat ? " с НДС" : ""}
                      {` · по ${change.budgetCheck.report.dateTo} · получен ${new Date(change.budgetCheck.report.receivedAt).toLocaleString("ru-RU")}`}
                      . Это сохранённый отчёт, а не текущий остаток.
                    </small>
                  ) : change.budgetCheck ? (
                    <small>
                      Подходящего отчёта о расходе пока нет. Запросите его в
                      разделе «Сверка данных».
                    </small>
                  ) : null}
                  {change.budgetCheck && (
                    <small>
                      Эта проверка не разрешает запуск показов или изменение
                      лимита.
                    </small>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => checkBudget(change.id)}
                  >
                    Проверить лимит в Директе
                  </button>
                  {change.budgetCheck && (
                    <BudgetPreviewForm
                      key={change.budgetCheck.id}
                      businessId={ws.id}
                      changeId={change.id}
                      ownerLimit={change.budgetCheck.plan.budgetKopecks}
                      enabled={ws.capabilities.directBudgetPilot}
                      onChanged={refresh}
                    />
                  )}
                  <MarkingCheckCard businessId={ws.id} changeId={change.id} />
                  <ModerationCard
                    businessId={ws.id}
                    changeId={change.id}
                    enabled={ws.capabilities.directModerationPilot}
                    clock={clock}
                    busy={busy}
                    onCheckDecision={() => inspectControl(change.id)}
                  />
                </div>
              )}
              {change.execution?.status === "succeeded" && (
                <DirectControlCard
                  review={ws.controlReviews?.find(
                    (item) => item.changeId === change.id,
                  )}
                />
              )}
              {change.execution?.status === "succeeded" && (
                <DirectResumeCard
                  businessId={ws.id}
                  changeId={change.id}
                  review={ws.controlReviews?.find(
                    (item) => item.changeId === change.id,
                  )}
                  enabled={ws.capabilities.directResumePilot}
                  clock={clock}
                />
              )}
              {change.execution?.status === "succeeded" && (
                <LiveShadowCard
                  review={ws.shadowReviews?.find(
                    (item) => item.changeId === change.id,
                  )}
                  job={ws.shadowReviewJobs?.find(
                    (item) => item.changeId === change.id,
                  )}
                  busy={busy}
                  onReview={() => reviewShadow(change.id)}
                />
              )}
              {change.execution?.status === "succeeded" &&
                ws.capabilities.directWritePilot && (
                  <div className="direct-execution-result" role="status">
                    <b>Управление кампанией в Директе</b>
                    <small>
                      Кампания №
                      {
                        change.execution.calls.find(
                          (item) => item.key === "campaign",
                        )?.ids[0]
                      }
                      {change.lifecycle?.afterState
                        ? ` · последнее подтвержденное состояние: ${change.lifecycle.afterState}`
                        : " · создана выключенной"}
                    </small>
                    {change.lifecycle?.status === "needs_reconciliation" ? (
                      <>
                        <p>
                          Ответ на остановку не подтвержден. Новая команда
                          заблокирована до проверки состояния.
                        </p>
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            inspectLifecycle(change.id, change.lifecycle!.id)
                          }
                        >
                          Проверить остановку
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="secondary"
                        disabled={
                          busy ||
                          change.lifecycle?.status === "checking" ||
                          change.lifecycle?.status === "sending"
                        }
                        onClick={() =>
                          suspendCampaign(
                            change.id,
                            change.plan?.campaignName || "кампания",
                            Number(
                              change.execution!.calls.find(
                                (item) => item.key === "campaign",
                              )!.ids[0],
                            ),
                          )
                        }
                      >
                        Проверить и остановить показы
                      </button>
                    )}
                  </div>
                )}
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}
type AudienceExperimentInput = {
  hypothesis: string;
  dimension:
    | "geo_radius"
    | "search_intent"
    | "interest_group"
    | "visitor_type"
    | "need_wording";
  control: { name: string; value: string };
  variant: { name: string; value: string };
  minDays: number;
  minClicksPerVariant: number;
  minGoalsPerVariant: number;
  probabilityThreshold: number;
  minimumRelativeLift: number;
};
function Experiments({
  ws,
  busy,
  navigate,
  tick,
  createAbPlan,
  createAudienceExperiment,
  createAbVariant,
  inspectAbVariant,
  syncAbReport,
  decideAb,
  inspectAbDecision,
}: {
  ws: Workspace;
  busy: boolean;
  navigate: (page: string) => void;
  tick: () => void;
  createAbPlan: (
    changeId: string,
    input: {
      hypothesis: string;
      variant: { title: string; text: string };
      minDays: number;
      minImpressionsPerVariant: number;
    },
  ) => void;
  createAudienceExperiment: (
    changeId: string,
    input: AudienceExperimentInput,
  ) => void;
  createAbVariant: (plan: DirectAbPlan) => void;
  inspectAbVariant: (plan: DirectAbPlan) => void;
  syncAbReport: (plan: DirectAbPlan) => void;
  decideAb: (
    plan: DirectAbPlan,
    operation: "rollback_variant" | "apply_outcome",
    targetAdId: string,
  ) => void;
  inspectAbDecision: (plan: DirectAbPlan) => void;
}) {
  if (ws.state.mode === "live")
    return (
      <LiveExperiments
        ws={ws}
        busy={busy}
        navigate={navigate}
        createAbPlan={createAbPlan}
        createAudienceExperiment={createAudienceExperiment}
        createAbVariant={createAbVariant}
        inspectAbVariant={inspectAbVariant}
        syncAbReport={syncAbReport}
        decideAb={decideAb}
        inspectAbDecision={inspectAbDecision}
      />
    );
  return (
    <>
      <section
        className="experiment-guide"
        aria-labelledby="experiment-guide-title"
      >
        <div className="experiment-guide-copy">
          <div className="experiment-guide-heading">
            <Split size={20} aria-hidden="true" />
            <div>
              <h2 id="experiment-guide-title">
                Проверяем, какой текст приводит больше обращений
              </h2>
              <p>
                Ритм показывает два похожих объявления и оставляет вариант,
                который люди выбирают чаще.
              </p>
            </div>
          </div>
          <small>
            За раз меняем только одну деталь. Если данных недостаточно, остаётся
            исходный текст.
          </small>
        </div>
        <div className="experiment-guide-action">
          <button
            className="secondary"
            disabled={busy || !ws.state.running}
            onClick={tick}
          >
            <Play size={14} />
            Добавить тестовый день
          </button>
          <small>Только демонстрационные данные</small>
        </div>
      </section>
      <div className="experiments-grid">
        {ws.state.experiments.map((e) => (
          <section className="card experiment-card" key={e.id}>
            <div className="card-heading">
              <Badge
                tone={
                  e.status === "running"
                    ? "amber"
                    : e.status === "completed"
                      ? "green"
                      : "gray"
                }
              >
                {e.status === "running"
                  ? "Собираем данные"
                  : e.status === "completed"
                    ? "Завершен"
                    : "Без победителя"}
              </Badge>
              <span className="muted small">
                День {e.elapsedDays} из {e.maxDays}
              </span>
            </div>
            <h2>{e.name}</h2>
            <p>{e.hypothesis}</p>
            <div className="experiment-variants">
              {e.variants.map((v, i) => (
                <div className={e.winner === i ? "winner" : ""} key={v.name}>
                  <span className="variant-letter">{i === 0 ? "А" : "Б"}</span>
                  <b>{v.name.slice(4)}</b>
                  <div>
                    <strong>
                      {v.clicks ? ((v.leads / v.clicks) * 100).toFixed(1) : "0"}
                      %
                    </strong>
                    <span>конверсия</span>
                  </div>
                  <small>
                    {v.leads} обращений / {v.clicks} переходов
                  </small>
                  {e.winner === i && (
                    <Badge>
                      <Check size={12} />
                      Применен
                    </Badge>
                  )}
                </div>
              ))}
            </div>
            <div className="experiment-progress">
              <i
                style={{
                  width: Math.min(100, (e.elapsedDays / e.maxDays) * 100) + "%",
                }}
              />
            </div>
            <div className="experiment-verdict">
              <Clock3 size={17} />
              {e.verdict}
            </div>
            <div className="small muted">
              Меняем: {e.factor.toLowerCase()} · Минимум {e.minClicks} переходов
              на вариант
              <br />
              Экспериментальные выборки синтетические, не добавляются к общей
              статистике.
            </div>
          </section>
        ))}
      </div>
      {!ws.state.experiments.length && (
        <Empty
          title="Идеи появятся вместе с данными"
          text="Запустите рекламу. Когда стоимость обращения окажется рядом с целевой, система предложит эксперимент."
        />
      )}
    </>
  );
}
function LiveExperiments({
  ws,
  busy,
  navigate,
  createAbPlan,
  createAudienceExperiment,
  createAbVariant,
  inspectAbVariant,
  syncAbReport,
  decideAb,
  inspectAbDecision,
}: {
  ws: Workspace;
  busy: boolean;
  navigate: (page: string) => void;
  createAbPlan: (
    changeId: string,
    input: {
      hypothesis: string;
      variant: { title: string; text: string };
      minDays: number;
      minImpressionsPerVariant: number;
    },
  ) => void;
  createAudienceExperiment: (
    changeId: string,
    input: AudienceExperimentInput,
  ) => void;
  createAbVariant: (plan: DirectAbPlan) => void;
  inspectAbVariant: (plan: DirectAbPlan) => void;
  syncAbReport: (plan: DirectAbPlan) => void;
  decideAb: (
    plan: DirectAbPlan,
    operation: "rollback_variant" | "apply_outcome",
    targetAdId: string,
  ) => void;
  inspectAbDecision: (plan: DirectAbPlan) => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [title, setTitle] = useState("");
  const [copy, setCopy] = useState("");
  const [minDays, setMinDays] = useState(14);
  const [minImpressions, setMinImpressions] = useState(1000);
  const [formError, setFormError] = useState("");
  const [confirmedPlanId, setConfirmedPlanId] = useState("");
  const [confirmedDecisionId, setConfirmedDecisionId] = useState("");
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const plans = ws.abPlans || [];
  const audiencePlans = ws.audienceExperiments || [];
  const available = ws.directChanges.filter(
    (change) =>
      ws.capabilities.abPlanning &&
      change.execution?.status === "succeeded" &&
      change.plan?.channel !== "network" &&
      change.plan?.ads.length === 1 &&
      change.plan.periodStart > today &&
      !plans.some((plan) => plan.changeId === change.id),
  );
  const selected =
    available.find((change) => change.id === selectedId) || available[0];
  const audienceCandidate = ws.directChanges.find(
    (change) =>
      change.execution?.status === "succeeded" &&
      !!change.plan &&
      change.plan.channel !== "network" &&
      change.plan.periodStart > today &&
      !audiencePlans.some((plan) => plan.changeId === change.id),
  );
  const renderAbStats = (plan: DirectAbPlan) => {
    if (!plan.variant.adId) return null;
    const report = ws.reports.find(
        (item) =>
          item.reportType === "ad" &&
          item.abPlanId === plan.id &&
          item.requestedAdIds.includes(plan.control.adId) &&
          item.requestedAdIds.includes(plan.variant.adId!),
      ),
      summarize = (adId: string) =>
        (report?.rows || [])
          .filter((row) => row.AdId === adId)
          .reduce(
            (total, row) => ({
              impressions: total.impressions + row.impressions,
              clicks: total.clicks + row.clicks,
            }),
            { impressions: 0, clicks: 0 },
          ),
      control = summarize(plan.control.adId),
      variant = summarize(plan.variant.adId),
      ctr = (item: { impressions: number; clicks: number }) =>
        item.impressions
          ? `${((item.clicks / item.impressions) * 100).toFixed(2)}%`
          : "—",
      pending = ws.reportJobs.some((job) =>
        ["pending", "running"].includes(job.status),
      ),
      beforeStart = today < plan.periodStart;
    return (
      <div className="ab-observed-stats">
        <div className="card-heading">
          <div>
            <b>Фактическая статистика объявлений</b>
            <p className="small muted">
              Только чтение. Данные группируются по ID объявления.
            </p>
          </div>
          {report && <Badge tone="gray">по {date(report.dateTo)}</Badge>}
        </div>
        {report ? (
          <div className="ab-stat-grid">
            <div>
              <span>А · CTR</span>
              <strong>{ctr(control)}</strong>
              <small>
                {count(control.clicks)} кликов · {count(control.impressions)}
                показов
              </small>
            </div>
            <div>
              <span>Б · CTR</span>
              <strong>{ctr(variant)}</strong>
              <small>
                {count(variant.clicks)} кликов · {count(variant.impressions)}
                показов
              </small>
            </div>
          </div>
        ) : (
          <p className="small muted">
            {beforeStart
              ? `Сбор станет доступен ${date(plan.periodStart)}, когда начнётся период.`
              : "Отчёт по двум объявлениям ещё не запрашивался."}
          </p>
        )}
        <button
          type="button"
          className="secondary"
          disabled={busy || pending || beforeStart}
          onClick={() => syncAbReport(plan)}
        >
          <RefreshCw size={15} />
          {pending ? "Отчёт формируется" : "Обновить статистику А/Б"}
        </button>
      </div>
    );
  };
  return (
    <>
      <div className="experiment-intro live-ab-intro">
        <div>
          <Split size={20} />
          <b>Проверить одну гипотезу</b>
        </div>
        <p>
          Зафиксируйте вариант до начала периода. Для вывода понадобятся два
          опубликованных объявления, сопоставимые показы и статистика по каждому
          из них. Сохранение плана не включает показы.
        </p>
      </div>
      <section className="card live-ab-form audience-experiment-panel">
        <div className="card-heading">
          <div>
            <h2>Тест аудитории</h2>
            <p className="muted">
              Сравниваем два сегмента с одинаковыми объявлениями и бюджетом.
              Меняется только географический радиус.
            </p>
          </div>
          <Badge tone="gray">50/50</Badge>
        </div>
        {audiencePlans.length > 0 ? (
          <div className="experiments-grid audience-experiment-grid">
            {audiencePlans.map((plan) => (
              <article className="experiment-card" key={plan.id}>
                <div className="card-heading">
                  <Badge
                    tone={
                      plan.status === "variant_wins" ||
                      plan.status === "control_wins"
                        ? "green"
                        : plan.status === "inconclusive"
                          ? "gray"
                          : "amber"
                    }
                  >
                    {plan.status === "planned"
                      ? "План сохранён"
                      : plan.status === "collecting"
                        ? "Собираем данные"
                        : plan.status === "inconclusive"
                          ? "Без победителя"
                          : "Есть статистический вывод"}
                  </Badge>
                  <span className="small muted">
                    Метрика: обращения / клики
                  </span>
                </div>
                <h3>{plan.hypothesis}</h3>
                <div className="experiment-variants">
                  <div>
                    <span className="variant-letter">А</span>
                    <b>{plan.control.name}</b>
                    <p>{plan.control.value}</p>
                  </div>
                  <div>
                    <span className="variant-letter">Б</span>
                    <b>{plan.variant.name}</b>
                    <p>{plan.variant.value}</p>
                  </div>
                </div>
                <div className="experiment-verdict">
                  <Clock3 size={17} />
                  {plan.conclusion}
                </div>
                <p className="small muted">
                  Победитель не выбирается до конца периода. Минимум 100 кликов
                  и 5 обращений на каждый сегмент.
                </p>
              </article>
            ))}
          </div>
        ) : audienceCandidate ? (
          <div className="audience-experiment-empty">
            <p>
              Система подготовит безопасную гипотезу «весь город против радиуса
              3 км». Тексты объявлений останутся неизменными.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                createAudienceExperiment(audienceCandidate.id, {
                  hypothesis:
                    "Люди рядом с бизнесом чаще записываются, чем аудитория по всему городу.",
                  dimension: "geo_radius",
                  control: {
                    name: "Весь город",
                    value: ws.state.city || "Город присутствия",
                  },
                  variant: {
                    name: "Рядом с бизнесом",
                    value: "Радиус 3 км",
                  },
                  minDays: 7,
                  minClicksPerVariant: 100,
                  minGoalsPerVariant: 5,
                  probabilityThreshold: 0.95,
                  minimumRelativeLift: 0.15,
                })
              }
            >
              Зафиксировать тест аудитории
            </button>
          </div>
        ) : (
          <p className="small muted">
            Тест станет доступен после создания и сверки выключенной кампании до
            начала её периода.
          </p>
        )}
      </section>
      {available.length > 0 && selected && (
        <section className="card live-ab-form">
          <div className="card-heading">
            <div>
              <h2>План нового сравнения</h2>
              <p className="muted">
                Это регистрация гипотезы. Объявление B не создаётся и показы не
                включаются.
              </p>
            </div>
            <Badge tone="gray">Черновик</Badge>
          </div>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (busy) return;
              if (
                hypothesis.trim().length < 12 ||
                title.trim().length < 2 ||
                copy.trim().length < 2 ||
                minDays < 7 ||
                minDays > 30 ||
                minImpressions < 500 ||
                minImpressions > 100000
              ) {
                setFormError(
                  "Заполните гипотезу и оба текста, затем проверьте срок и минимальное число показов.",
                );
                return;
              }
              setFormError("");
              createAbPlan(selected.id, {
                hypothesis,
                variant: { title, text: copy },
                minDays,
                minImpressionsPerVariant: minImpressions,
              });
            }}
          >
            <div className="direct-form-grid">
              <label className="wide">
                Кампания
                <select
                  value={selected.id}
                  onChange={(e) => setSelectedId(e.target.value)}
                >
                  {available.map((change) => (
                    <option key={change.id} value={change.id}>
                      {change.plan?.campaignName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wide">
                Гипотеза
                <textarea
                  className="resize-none"
                  rows={3}
                  value={hypothesis}
                  onChange={(e) => setHypothesis(e.target.value)}
                  minLength={12}
                  maxLength={500}
                  required
                  aria-invalid={
                    formError && hypothesis.trim().length < 12
                      ? "true"
                      : undefined
                  }
                  placeholder="Например: конкретная выгода в заголовке повысит долю переходов"
                />
              </label>
              <div className="ab-control-preview wide">
                <span className="small muted">
                  Вариант А · существующее объявление
                </span>
                <b>
                  {selected.plan && selected.plan.channel !== "network"
                    ? selected.plan.ads[0].title
                    : ""}
                </b>
                <p>
                  {selected.plan && selected.plan.channel !== "network"
                    ? selected.plan.ads[0].text
                    : ""}
                </p>
              </div>
              <label>
                Заголовок варианта Б
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  minLength={2}
                  maxLength={56}
                  required
                  aria-invalid={
                    formError && title.trim().length < 2 ? "true" : undefined
                  }
                />
              </label>
              <label>
                Текст варианта Б
                <input
                  value={copy}
                  onChange={(e) => setCopy(e.target.value)}
                  minLength={2}
                  maxLength={81}
                  required
                  aria-invalid={
                    formError && copy.trim().length < 2 ? "true" : undefined
                  }
                />
              </label>
              <label>
                Минимум дней
                <input
                  type="number"
                  min={7}
                  max={30}
                  step={1}
                  value={minDays}
                  onChange={(e) => setMinDays(Number(e.target.value))}
                  required
                />
              </label>
              <label>
                Минимум показов на вариант
                <input
                  type="number"
                  min={500}
                  max={100000}
                  step={1}
                  value={minImpressions}
                  onChange={(e) => setMinImpressions(Number(e.target.value))}
                  required
                />
              </label>
            </div>
            <p className="small muted">
              Основная метрика — доля переходов (CTR). Порог показов сам по себе
              не доказывает победу; итог можно оценивать только после срока
              теста и проверки равномерности трафика.
            </p>
            {formError && <p role="alert">{formError}</p>}
            <button type="submit" disabled={busy}>
              Сохранить A/B-план
            </button>
          </form>
        </section>
      )}
      <div className="experiments-grid">
        {plans.map((plan) => (
          <section className="card experiment-card live-ab-card" key={plan.id}>
            <div className="card-heading">
              <Badge tone={plan.variant.adId ? "green" : "amber"}>
                {plan.status === "variant_rolled_back"
                  ? "Вариант Б удалён"
                  : plan.status === "outcome_applied"
                    ? "Результат применён"
                    : plan.variant.adId
                      ? "Вариант Б создан"
                      : "План сохранён"}
              </Badge>
              <span className="muted small">Кампания №{plan.campaignId}</span>
            </div>
            <h2>Проверяем гипотезу</h2>
            <p>{plan.hypothesis}</p>
            <div className="experiment-variants">
              <div>
                <span className="variant-letter">А</span>
                <b>{plan.control.title}</b>
                <p>{plan.control.text}</p>
                <small>ID {plan.control.adId}</small>
              </div>
              <div>
                <span className="variant-letter">Б</span>
                <b>{plan.variant.title}</b>
                <p>{plan.variant.text}</p>
                <small>
                  {plan.status === "variant_rolled_back"
                    ? `ID ${plan.variant.adId} · черновик удалён`
                    : plan.variant.adId
                      ? `ID ${plan.variant.adId} · показы выключены`
                      : "Пока не создан в Директе"}
                </small>
              </div>
            </div>
            <div className="small muted ab-plan-terms">
              Период {date(plan.periodStart)} — {date(plan.periodEnd)} · минимум{" "}
              {plan.minDays} дней и{" "}
              {plan.minImpressionsPerVariant.toLocaleString("ru-RU")} показов на
              вариант · метрика CTR
            </div>
            <div className="experiment-verdict">
              <Clock3 size={17} />
              {plan.verdict}
            </div>
            {renderAbStats(plan)}
            <ul className="ab-blockers small">
              {plan.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
            {!plan.variant.adId && (
              <div className="ab-variant-action">
                {plan.action?.status === "needs_reconciliation" ? (
                  <>
                    <p role="alert" className="small">
                      Ответ на создание не подтверждён. Повторная отправка
                      заблокирована до чтения группы объявлений.
                    </p>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => inspectAbVariant(plan)}
                    >
                      Проверить вариант в Директе
                    </button>
                  </>
                ) : (
                  <>
                    <label className="direct-budget-confirm">
                      <input
                        type="checkbox"
                        checked={confirmedPlanId === plan.id}
                        onChange={(event) =>
                          setConfirmedPlanId(
                            event.target.checked ? plan.id : "",
                          )
                        }
                      />
                      <span>
                        Я проверил тексты А и Б. Создать только объявление Б,
                        без модерации и запуска показов.
                      </span>
                    </label>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        !ws.capabilities.directAbVariantPilot ||
                        confirmedPlanId !== plan.id ||
                        ["checking", "sending"].includes(
                          plan.action?.status || "",
                        )
                      }
                      onClick={() => createAbVariant(plan)}
                    >
                      Создать выключенный вариант Б
                    </button>
                    {!ws.capabilities.directAbVariantPilot && (
                      <small className="muted">
                        Пилот выключен на сервере. План можно проверить без
                        записи в Директ.
                      </small>
                    )}
                  </>
                )}
              </div>
            )}
            {plan.variant.adId && (
              <div className="ab-decision-action">
                {plan.decision?.status === "needs_reconciliation" ? (
                  <>
                    <p role="alert" className="small">
                      Ответ Директа не подтверждён. Повторная запись
                      заблокирована до чтения объявления.
                    </p>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => inspectAbDecision(plan)}
                    >
                      Проверить результат в Директе
                    </button>
                  </>
                ) : plan.decision?.status === "succeeded" ? (
                  <div className="info-note ab-decision-result">
                    <b>
                      {plan.decision.operation === "rollback_variant"
                        ? "Черновик варианта Б удалён"
                        : "Проигравшее объявление остановлено"}
                    </b>
                    <p>
                      Объявление №{plan.decision.targetAdId} · подтверждено
                      состояние {plan.decision.afterState}.
                    </p>
                  </div>
                ) : plan.outcome === "control_wins" ||
                  plan.outcome === "variant_wins" ||
                  (today < plan.periodStart && !plan.evidence.reportId) ? (
                  <>
                    {(() => {
                      const applying =
                          plan.outcome === "control_wins" ||
                          plan.outcome === "variant_wins",
                        operation = applying
                          ? "apply_outcome"
                          : "rollback_variant",
                        targetAdId = applying
                          ? plan.outcome === "variant_wins"
                            ? plan.control.adId
                            : plan.variant.adId!
                          : plan.variant.adId!,
                        confirmationKey = `${plan.id}:${operation}`;
                      return (
                        <>
                          <label className="direct-budget-confirm">
                            <input
                              type="checkbox"
                              checked={confirmedDecisionId === confirmationKey}
                              onChange={(event) =>
                                setConfirmedDecisionId(
                                  event.target.checked ? confirmationKey : "",
                                )
                              }
                            />
                            <span>
                              {applying
                                ? `Я подтверждаю итог теста. Остановить только проигравшее объявление №${targetAdId}.`
                                : `Удалить только выключенный черновик Б №${targetAdId}. Контроль А не изменять.`}
                            </span>
                          </label>
                          <button
                            type="button"
                            className={applying ? "primary" : "danger-button"}
                            disabled={
                              busy ||
                              !ws.capabilities.directAbDecisionPilot ||
                              confirmedDecisionId !== confirmationKey
                            }
                            onClick={() =>
                              decideAb(plan, operation, targetAdId)
                            }
                          >
                            {applying
                              ? "Применить подтверждённый результат"
                              : "Удалить черновик варианта Б"}
                          </button>
                        </>
                      );
                    })()}
                    {!ws.capabilities.directAbDecisionPilot && (
                      <small className="muted">
                        Операция выключена на сервере. Статус и статистика
                        доступны без записи в Директ.
                      </small>
                    )}
                  </>
                ) : (
                  <p className="small muted">
                    Результат пока нельзя применять. Дождитесь конца периода и
                    итогового отчёта; при неубедительном результате объявления
                    остаются без изменений.
                  </p>
                )}
              </div>
            )}
          </section>
        ))}
      </div>
      {!plans.length && !available.length && (
        <Empty
          title="Пока нечего сравнивать"
          text="Сначала создайте и сверьте выключенную кампанию с одним объявлением. Гипотезу нужно зафиксировать до начала периода."
          action={
            <button className="secondary" onClick={() => navigate("campaigns")}>
              Открыть рекламу <ArrowRight size={16} />
            </button>
          }
        />
      )}
    </>
  );
}
function Creatives({
  ws,
  busy,
  navigate,
  approve,
  generateImage,
  connectKie,
  disconnectKie,
  approveImage,
  uploadImage,
  inspectImage,
  removeImage,
  refresh,
}: {
  ws: Workspace;
  busy: boolean;
  navigate: (page: string) => void;
  approve: (id: string) => Promise<boolean>;
  generateImage: (input: {
    prompt?: string;
    style: "editorial" | "local" | "detail";
    goal: "leads" | "trust" | "offer";
    hook: "outcome" | "human" | "perspective";
    format: "standard" | "square" | "wide" | "vertical";
    audience: string;
    brandPlacement: "none" | "bottom-left" | "bottom-right";
  }) => Promise<void>;
  connectKie: (apiKey: string) => Promise<void>;
  disconnectKie: () => void;
  approveImage: (id: string) => void;
  uploadImage: (id: string, login: string) => void;
  inspectImage: (id: string, login: string) => void;
  removeImage: (id: string) => void;
  refresh: () => Promise<void>;
}) {
  const [style, setStyle] = useState<"editorial" | "local" | "detail">(
      "editorial",
    ),
    [goal, setGoal] = useState<"leads" | "trust" | "offer">("leads"),
    [hook, setHook] = useState<"outcome" | "human" | "perspective">("outcome"),
    [format, setFormat] = useState<"standard" | "square" | "wide" | "vertical">(
      "standard",
    ),
    [brandPlacement, setBrandPlacement] = useState<
      "none" | "bottom-left" | "bottom-right"
    >("none"),
    [hasCostConsent, setHasCostConsent] = useState(false),
    [apiKey, setApiKey] = useState(""),
    [setupError, setSetupError] = useState(""),
    [approvingTextId, setApprovingTextId] = useState(""),
    [textApprovalError, setTextApprovalError] = useState(""),
    [textApprovalErrorId, setTextApprovalErrorId] = useState(""),
    [directLogin, setDirectLogin] = useState(
      ws.connections.find((connection) => connection.provider === "yandex")
        ?.clients?.[0]?.Login || "",
    );
  const kieConnected = ws.capabilities.creativeImageProvider === "kie";
  const directClients =
    ws.connections.find((connection) => connection.provider === "yandex")
      ?.clients || [];
  const hasPendingImages = ws.creativeImages.some((image) =>
    ["pending", "running"].includes(image.status),
  );
  useEffect(() => {
    if (!hasPendingImages) return;
    const timer = window.setInterval(
      () => void refresh().catch(() => {}),
      2_500,
    );
    return () => window.clearInterval(timer);
  }, [hasPendingImages, ws.id]);
  const statuses = {
    pending: "В очереди",
    running: "Создаётся",
    succeeded: "Готово",
    failed: "Не удалось",
  } as const;
  async function approveText(id: string) {
    if (busy || approvingTextId) return;
    setApprovingTextId(id);
    setTextApprovalError("");
    setTextApprovalErrorId("");
    const approved = await approve(id);
    if (!approved) {
      setTextApprovalError(
        "Не удалось сохранить выбор. Обновите страницу и попробуйте ещё раз.",
      );
      setTextApprovalErrorId(id);
    }
    setApprovingTextId("");
  }
  return (
    <>
      <section className="card creative-generator">
        <div className="creative-generator-copy">
          <span className="eyebrow">ИЗОБРАЖЕНИЯ ДЛЯ РЕКЛАМЫ</span>
          <h2>Покажите услугу так, чтобы захотелось записаться</h2>
          <p>
            Ничего придумывать и писать не нужно. Рита возьмёт услугу, город и
            преимущество из профиля, а вы выберете, на чём сделать акцент.
          </p>
          <dl
            className="creative-specs"
            aria-label="Как Ритм подготовит изображение"
          >
            <div>
              <dt>Сюжет</dt>
              <dd>из данных о бизнесе</dd>
            </div>
            <div>
              <dt>Формат</dt>
              <dd>под выбранное размещение</dd>
            </div>
            <div>
              <dt>Публикация</dt>
              <dd>только после вашей проверки</dd>
            </div>
          </dl>
          <div className="creative-safety-note">
            <ShieldCheck size={17} /> Никакой автоматической публикации или
            списаний
          </div>
        </div>
        {kieConnected ? (
          <form
            noValidate
            className="creative-generator-form"
            onSubmit={(event) => {
              event.preventDefault();
              void generateImage({
                prompt: "",
                style,
                goal,
                hook,
                format,
                audience: "",
                brandPlacement,
              });
            }}
          >
            <div className="creative-provider-status">
              <span>
                <i aria-hidden="true" /> Kie.ai подключён · GPT Image 2.5
              </span>
              <button type="button" onClick={disconnectKie} disabled={busy}>
                Отключить
              </button>
            </div>
            <fieldset className="creative-choice-group">
              <legend>Задача фотографии</legend>
              <div className="creative-choice-row goal-options">
                {(
                  [
                    ["leads", "Получить заявки", "Понятно показать услугу"],
                    ["trust", "Вызвать доверие", "Показать процесс и заботу"],
                    [
                      "offer",
                      "Раскрыть выгоду",
                      "Сфокусироваться на результате",
                    ],
                  ] as const
                ).map(([value, title, text]) => (
                  <label
                    key={value}
                    className={goal === value ? "selected" : ""}
                  >
                    <input
                      type="radio"
                      name="creative-goal"
                      value={value}
                      checked={goal === value}
                      onChange={() => setGoal(value)}
                    />
                    <span>
                      <b>{title}</b>
                      <small>{text}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="creative-choice-group">
              <legend>Что остановит взгляд</legend>
              <div className="creative-choice-row hook-options">
                {(
                  [
                    [
                      "outcome",
                      "Желаемый результат",
                      "Выгода понятна за секунду",
                    ],
                    [
                      "human",
                      "Живой момент",
                      "Эмоция без постановочной улыбки",
                    ],
                    [
                      "perspective",
                      "Сильный ракурс",
                      "Контрастный кадр без сюрреализма",
                    ],
                  ] as const
                ).map(([value, title, text]) => (
                  <label
                    key={value}
                    className={hook === value ? "selected" : ""}
                  >
                    <input
                      type="radio"
                      name="creative-hook"
                      value={value}
                      checked={hook === value}
                      onChange={() => setHook(value)}
                    />
                    <span>
                      <b>{title}</b>
                      <small>{text}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label htmlFor="creative-style">
              Визуальный подход
              <select
                id="creative-style"
                value={style}
                onChange={(event) =>
                  setStyle(
                    event.target.value as "editorial" | "local" | "detail",
                  )
                }
              >
                <option value="editorial">Редакционная фотография</option>
                <option value="local">Живой локальный бизнес</option>
                <option value="detail">Акцент на деталях</option>
              </select>
            </label>
            <fieldset className="creative-choice-group format-choice">
              <legend>Формат размещения</legend>
              <div className="creative-format-row">
                {(
                  [
                    ["standard", "4:3", "Основной"],
                    ["square", "1:1", "Квадрат"],
                    ["wide", "16:9", "Широкий"],
                    ["vertical", "3:4", "Вертикальный"],
                  ] as const
                ).map(([value, ratio, title]) => (
                  <label
                    key={value}
                    className={format === value ? "selected" : ""}
                  >
                    <input
                      type="radio"
                      name="creative-format"
                      value={value}
                      checked={format === value}
                      onChange={() => setFormat(value)}
                    />
                    <span
                      className={`format-shape ${value}`}
                      aria-hidden="true"
                    />
                    <span>
                      <b>{ratio}</b>
                      <small>{title}</small>
                    </span>
                  </label>
                ))}
              </div>
              <p className="field-hint format-hint">
                Для первого варианта рекомендуем 4:3: Директ использует его на
                большинстве площадок.
              </p>
            </fieldset>
            <fieldset className="creative-choice-group brand-choice">
              <legend>Название компании на изображении</legend>
              <div className="brand-name-preview">
                <span>Название из профиля</span>
                <strong>{ws.state.name}</strong>
              </div>
              <div className="creative-choice-row brand-options">
                {(
                  [
                    ["none", "Без названия", "Чистая фотография"],
                    ["bottom-left", "Слева", "В нижнем углу"],
                    ["bottom-right", "Справа", "В нижнем углу"],
                  ] as const
                ).map(([value, title, text]) => (
                  <label
                    key={value}
                    className={brandPlacement === value ? "selected" : ""}
                  >
                    <input
                      type="radio"
                      name="creative-brand-placement"
                      value={value}
                      checked={brandPlacement === value}
                      onChange={() => setBrandPlacement(value)}
                    />
                    <span>
                      <b>{title}</b>
                      <small>{text}</small>
                    </span>
                  </label>
                ))}
              </div>
              <p className="field-hint format-hint">
                По умолчанию оставляем чистую фотографию. Если добавить
                название, Ритм заранее оставит для него спокойное место, а затем
                нанесёт небольшую светлую подпись кириллическим шрифтом. Буквы
                не будут искажены моделью.
              </p>
            </fieldset>
            <button
              className="primary"
              disabled={busy || !hasCostConsent || !kieConnected}
            >
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Images size={17} />
              )}
              <span>{busy ? "Создаём вариант…" : "Подготовить вариант"}</span>
            </button>
            <label className="creative-cost-consent">
              <input
                type="checkbox"
                checked={hasCostConsent}
                onChange={(event) => setHasCostConsent(event.target.checked)}
              />
              <span>
                Понимаю: Kie.ai спишет кредиты за новый вариант. В рекламу он не
                попадёт без моей проверки.
              </span>
            </label>
          </form>
        ) : (
          <form
            className="creative-generator-unavailable creative-provider-setup"
            aria-label="Подключение генерации изображений"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const value = apiKey.trim();
              if (value.length < 16) {
                setSetupError("Вставьте полный API-ключ Kie.ai.");
                return;
              }
              setSetupError("");
              void connectKie(value);
            }}
          >
            <span
              className="creative-generator-unavailable-icon"
              aria-hidden="true"
            >
              <Images size={22} />
            </span>
            <div>
              <h3>Подключите Kie.ai · GPT Image 2.5</h3>
              <p>
                Вставьте API-ключ один раз. Рита сама составит описание кадра по
                профилю бизнеса и отправит его в GPT Image 2.5. Промпты писать
                не нужно.
              </p>
              {ws.capabilities.creativeImageSetup ? (
                <>
                  <label htmlFor="kie-image-key">
                    API-ключ Kie.ai
                    <input
                      id="kie-image-key"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={apiKey}
                      onChange={(event) => {
                        setApiKey(event.target.value);
                        if (setupError) setSetupError("");
                      }}
                      aria-describedby="kie-image-key-help kie-image-key-error"
                    />
                  </label>
                  <small id="kie-image-key-help">
                    Ключ хранится на сервере в зашифрованном виде и больше не
                    показывается в браузере.
                  </small>
                  <small
                    id="kie-image-key-error"
                    className="field-error"
                    role="alert"
                  >
                    {setupError}
                  </small>
                  <div className="creative-provider-actions">
                    <button
                      className="primary"
                      disabled={busy || apiKey.trim().length < 16}
                    >
                      Подключить Kie.ai
                    </button>
                    <a
                      href="https://kie.ai/api-key"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Где взять ключ
                    </a>
                  </div>
                </>
              ) : (
                <p className="creative-provider-warning">
                  На сервере не настроено постоянное шифрование. Сначала
                  добавьте TOKEN_ENCRYPTION_KEY, затем вернитесь сюда.
                </p>
              )}
            </div>
          </form>
        )}
      </section>
      {!!ws.creativeImages.length && (
        <section className="generated-section">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Недавние генерации</span>
              <h2>Визуалы на проверке</h2>
            </div>
            {!!directClients.length && (
              <label className="creative-direct-account">
                Кабинет для будущей рекламы
                <select
                  value={directLogin}
                  onChange={(event) => setDirectLogin(event.target.value)}
                >
                  {directClients.map((client) => (
                    <option key={client.Login} value={client.Login}>
                      {client.Login}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="generated-grid">
            {ws.creativeImages.map((image) => (
              <article className="card generated-card" key={image.id}>
                <div className={`generated-preview format-${image.format}`}>
                  {image.imageUrl ? (
                    <img
                      src={image.imageUrl}
                      alt="Созданный рекламный визуал"
                    />
                  ) : image.status === "failed" ? (
                    <div className="generated-placeholder failed">
                      <X size={24} />
                      <span>{image.error || "Генерация не выполнена"}</span>
                    </div>
                  ) : (
                    <div className="generated-placeholder">
                      <LoaderCircle className="spin" size={24} />
                      <span>{statuses[image.status]}</span>
                    </div>
                  )}
                  <Badge
                    tone={
                      image.approvedAt
                        ? "green"
                        : image.status === "failed"
                          ? "red"
                          : "gray"
                    }
                  >
                    {image.approvedAt ? "Согласовано" : statuses[image.status]}
                  </Badge>
                </div>
                <div className="generated-body">
                  <p>{image.prompt}</p>
                  <div className="generated-meta">
                    <span>
                      {image.goal === "trust"
                        ? "Доверие"
                        : image.goal === "offer"
                          ? "Выгода"
                          : "Заявки"}
                    </span>
                    <span>
                      {image.width && image.height
                        ? `${image.width} × ${image.height}`
                        : image.ratio || "Подготовка"}
                    </span>
                    <span>
                      {image.hook === "human"
                        ? "Живой момент"
                        : image.hook === "perspective"
                          ? "Сильный ракурс"
                          : "Результат"}
                    </span>
                  </div>
                  {image.companyName && (
                    <div className="generated-brand-meta">
                      <span>Название на макете</span>
                      <b>{image.companyName}</b>
                    </div>
                  )}
                  {image.status === "succeeded" && !image.approvedAt && (
                    <div className="creative-quality-check">
                      <b>Перед согласованием</b>
                      <span>
                        Проверьте руки и лица, предметы, надпись и связь кадра с
                        услугой.
                      </span>
                    </div>
                  )}
                  <div className="generated-actions">
                    {image.status === "succeeded" && (
                      <button
                        type="button"
                        className={
                          image.approvedAt
                            ? "approved-button full"
                            : "secondary full"
                        }
                        disabled={busy || !!image.approvedAt}
                        onClick={() => approveImage(image.id)}
                      >
                        <Check size={16} />
                        {image.approvedAt
                          ? "Согласовано"
                          : "Согласовать изображение"}
                      </button>
                    )}
                    {!image.approvedAt &&
                      ["succeeded", "failed"].includes(image.status) && (
                        <button
                          type="button"
                          className="text-button generated-remove"
                          disabled={busy}
                          onClick={() => removeImage(image.id)}
                        >
                          <Trash2 size={15} /> Удалить вариант
                        </button>
                      )}
                    {image.approvedAt &&
                      image.directUploads.some(
                        (upload) => upload.login === directLogin,
                      ) && (
                        <p className="creative-direct-status" role="status">
                          <CheckCircle2 size={16} /> Добавлено в Директ. Показы
                          не запущены.
                        </p>
                      )}
                    {image.approvedAt &&
                      directLogin &&
                      !image.directUploads.some(
                        (upload) => upload.login === directLogin,
                      ) &&
                      ws.capabilities.directImageUploadPilot &&
                      !safeStorage.getItem(
                        `ritm:direct-image:${ws.id}:${image.id}:${directLogin}`,
                      ) && (
                        <button
                          type="button"
                          className="primary full"
                          disabled={busy}
                          onClick={() => uploadImage(image.id, directLogin)}
                        >
                          <Images size={16} /> Добавить в будущую рекламу
                        </button>
                      )}
                    {image.approvedAt &&
                      directLogin &&
                      !image.directUploads.some(
                        (upload) => upload.login === directLogin,
                      ) &&
                      !!safeStorage.getItem(
                        `ritm:direct-image:${ws.id}:${image.id}:${directLogin}`,
                      ) && (
                        <button
                          type="button"
                          className="secondary full"
                          disabled={busy}
                          onClick={() => inspectImage(image.id, directLogin)}
                        >
                          <RefreshCw size={16} /> Сверить загрузку
                        </button>
                      )}
                    {image.approvedAt &&
                      directLogin &&
                      !image.directUploads.some(
                        (upload) => upload.login === directLogin,
                      ) &&
                      !ws.capabilities.directImageUploadPilot && (
                        <p className="creative-direct-unavailable">
                          Добавление в Директ отключено на этом сервере. Файл
                          останется согласованным и не будет опубликован.
                        </p>
                      )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      <div className="info-box neutral">
        <BookOpen size={20} />
        <span>
          Можно разрешить все три текста: в поиске они станут отдельными
          объявлениями, а в Рекламной сети Яндекс сможет сочетать разрешённые
          заголовки и описания. Здесь ничего не отправляется — итоговую сборку с
          фотографией вы увидите на шаге «План и запуск». Цветные карточки ниже
          — только концепции, не готовые изображения.
        </span>
      </div>
      <div className="creative-grid">
        {ws.state.creatives.map((c, i) => (
          <section className="card creative-card" key={c.id}>
            <div className={"creative-art " + c.color}>
              <span>{ws.state.name}</span>
              <div className="art-shape" />
              <b>
                {[
                  "Ближе, чем<br/>кажется.",
                  "Время<br/>для себя.",
                  "Красота<br/>в деталях.",
                ][i % 3]
                  .split("<br/>")
                  .map((line, j) => (
                    <React.Fragment key={j}>
                      {line}
                      <br />
                    </React.Fragment>
                  ))}
              </b>
              <small>ВИЗУАЛЬНАЯ КОНЦЕПЦИЯ · НЕ РЕКЛАМНЫЙ АССЕТ</small>
            </div>
            <div className="creative-body">
              <div className="creative-meta">
                <Badge tone="gray">{c.angle}</Badge>
                <span>Текстовое объявление</span>
              </div>
              <h3>{c.title}</h3>
              <p>{c.text}</p>
              <div className="ad-url">
                <span>Реклама</span>
                {ws.state.website
                  ? new URL(ws.state.website).hostname
                  : "Сайт не указан"}
              </div>
              <button
                type="button"
                className={
                  c.status === "approved"
                    ? "approved-button full"
                    : "secondary full"
                }
                disabled={busy || c.status === "approved"}
                aria-busy={approvingTextId === c.id}
                onClick={() => void approveText(c.id)}
              >
                {approvingTextId === c.id ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Check size={16} />
                )}
                {c.status === "approved"
                  ? "Разрешён для рекламы"
                  : approvingTextId === c.id
                    ? "Сохраняем выбор…"
                    : "Разрешить использовать"}
              </button>
              {textApprovalError && textApprovalErrorId === c.id && (
                <small className="field-error" role="alert">
                  {textApprovalError}
                </small>
              )}
            </div>
          </section>
        ))}
      </div>
      {ws.capabilities.postgresPilot &&
        ws.state.creatives.some((item) => item.status === "approved") && (
          <section className="card creative-next-step">
            <div>
              <b>Тексты выбраны</b>
              <p>
                Вернитесь к плану. Там вы увидите точные тексты вместе с
                выбранным изображением до отправки в Директ.
              </p>
            </div>
            <button
              type="button"
              className="primary"
              onClick={() => navigate("campaigns")}
            >
              Продолжить запуск <ArrowRight size={16} />
            </button>
          </section>
        )}
      {!ws.state.creatives.length && (
        <Empty
          title="Расскажите о своем предложении"
          text="Заполните профиль бизнеса и нажмите «Подготовить тексты»."
        />
      )}
    </>
  );
}
function EventIcon({ kind }: { kind: string }) {
  const Icon = kind.includes("experiment")
    ? Split
    : kind === "pause"
      ? Pause
      : kind === "rebalance"
        ? TrendingUp
        : kind === "rollback"
          ? Undo2
          : kind === "budget"
            ? Wallet
            : Check;
  return (
    <span
      className={
        "event-icon " +
        (kind.includes("experiment")
          ? "lavender"
          : kind === "pause"
            ? "orange"
            : "")
      }
    >
      <Icon size={18} />
    </span>
  );
}
function HistoryView({
  ws,
  busy,
  undo,
  rollbackOptimizer,
}: {
  ws: Workspace;
  busy: boolean;
  undo: (e: Change) => void;
  rollbackOptimizer: (action: Workspace["optimizerActions"][number]) => void;
}) {
  const [filter, setFilter] = useState("all");
  const entries = ws.events.filter(
    (e) =>
      filter === "all" ||
      (filter === "system" ? e.rule !== "user" : e.rule === "user"),
  );
  return (
    <>
      <div className="toolbar">
        <div className="segmented">
          {[
            ["all", "Все действия"],
            ["system", "Решения системы"],
            ["user", "Мои изменения"],
          ].map(([id, label]) => (
            <button
              className={filter === id ? "active" : ""}
              key={id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="small muted">Записи сохраняются на сервере</span>
      </div>
      {!!ws.optimizerActions.length && (
        <section className="card history-list optimizer-history">
          <div className="card-heading">
            <div>
              <h2>Защита бюджета</h2>
              <p className="muted">
                Защитные действия по фактическим данным Direct и Метрики.
              </p>
            </div>
            <Badge tone="gray">Автопилот</Badge>
          </div>
          {ws.optimizerActions.map((action) => (
            <article key={action.id}>
              <EventIcon
                kind={action.action === "pause_campaign" ? "pause" : "budget"}
              />
              <div className="history-main">
                <div className="history-title">
                  <h3>
                    {action.action === "pause_campaign"
                      ? "Защитная остановка рекламы"
                      : "Перераспределение остатка"}
                  </h3>
                  <Badge
                    tone={
                      action.status === "applied" ||
                      action.status === "rolled_back"
                        ? "green"
                        : action.status.includes("reconciliation")
                          ? "red"
                          : "gray"
                    }
                  >
                    {action.status === "proposed"
                      ? "Ожидает выполнения"
                      : action.status === "dispatching"
                        ? "Выполняется"
                        : action.status === "applied"
                          ? "Применено"
                          : action.status === "rolled_back"
                            ? "Отменено"
                            : action.status.includes("reconciliation")
                              ? "Нужна сверка"
                              : "Не применено"}
                  </Badge>
                </div>
                <p>{action.reason}</p>
                <small>{time(action.createdAt, ws.state.timezone)}</small>
              </div>
              {action.status === "applied" && (
                <button
                  type="button"
                  className="secondary undo-button"
                  disabled={busy}
                  onClick={() => rollbackOptimizer(action)}
                >
                  <Undo2 size={14} />
                  Откатить
                </button>
              )}
            </article>
          ))}
        </section>
      )}
      <section className="card history-list">
        {entries.map((e) => (
          <article key={e.id}>
            <EventIcon kind={e.kind} />
            <div className="history-main">
              <div className="history-title">
                <h3>{e.title}</h3>
                <Badge tone="gray">{e.rule === "user" ? "Вы" : "Ритм"}</Badge>
              </div>
              <p>{displayEventReason(e.reason)}</p>
              <small>{time(e.at, ws.state.timezone)}</small>
              {e.before && (
                <details>
                  <summary>Что изменилось</summary>
                  <div className="diff-grid">
                    <div>
                      <b>До</b>
                      <pre>{JSON.stringify(e.before, null, 2)}</pre>
                    </div>
                    <div>
                      <b>После</b>
                      <pre>{JSON.stringify(e.after, null, 2)}</pre>
                    </div>
                  </div>
                </details>
              )}
              {e.rule && e.rule !== "user" && e.kind !== "ai_plan" && (
                <details className="history-technical">
                  <summary>Технические детали</summary>
                  <small>Правило: {e.rule}</small>
                </details>
              )}
            </div>
            {["pause", "rebalance"].includes(e.kind) &&
              (ws.events.some((r) => r.rollbackOf === e.id) ? (
                <Badge tone="gray">Отменено</Badge>
              ) : (
                <button
                  className="secondary undo-button"
                  onClick={() => undo(e)}
                >
                  <Undo2 size={14} />
                  Откатить
                </button>
              ))}
          </article>
        ))}
        {!entries.length && (
          <Empty
            title="Пока нет действий"
            text="Новые решения появятся здесь вместе с объяснениями."
          />
        )}
      </section>
    </>
  );
}
function Connections({
  ws,
  busy,
  connectDemo,
  refresh,
  disconnect,
}: {
  ws: Workspace;
  busy: boolean;
  connectDemo: () => void;
  refresh: () => void;
  disconnect: () => void;
}) {
  type MetricaSetup = {
    ready: boolean;
    counter: { id: string; name: string; sites: string[] };
    goal: {
      id: string;
      name: string;
      type: string;
      eventName: string | null;
    };
    installation: {
      counterCode: string;
      goalCall: string | null;
      placement: string;
    };
    checks: {
      code: string;
      status: "ok" | "warning";
      message: string;
    }[];
  };
  const [error, setError] = useState(""),
    [reading, setReading] = useState(false),
    [login, setLogin] = useState(""),
    [yandexCode, setYandexCode] = useState(""),
    [counters, setCounters] = useState<{ id: number; name: string }[]>([]),
    [goals, setGoals] = useState<{ id: number; name: string }[]>([]),
    [counterId, setCounterId] = useState(ws.state.counterId || ""),
    [goalId, setGoalId] = useState(ws.state.goalId || ""),
    [metricaSetup, setMetricaSetup] = useState<MetricaSetup | null>(null),
    [sitePath, setSitePath] = useState<"website" | "yandex">(
      ws.state.landingMode === "yandex_landing" || !ws.state.website
        ? "yandex"
        : "website",
    ),
    [destinationUrl, setDestinationUrl] = useState(ws.state.website || ""),
    [copied, setCopied] = useState<"counter" | "goal" | "description" | null>(
      null,
    );
  const linked = ws.connections.find((c) => c.provider === "yandex"),
    directVerified = linked?.validation === "verified",
    directBlocked = linked?.validation === "blocked",
    needsReconnect = linked?.validation === "reauth_required",
    retiredSandbox = linked?.sandbox === true,
    visibleError = retiredSandbox ? "" : error;
  const directHelp =
    linked?.validationCode === "application_access_pending"
      ? {
          href: "https://direct.yandex.ru/registered/main.pl?cmd=apiCertificationRequestList",
          label: "Проверить заявку в Директе",
        }
      : linked?.validationCode === "direct_account_missing"
        ? {
            href: "https://direct.yandex.ru/",
            label: "Создать кабинет Директа",
          }
        : linked?.validationCode === "direct_api_disabled"
          ? {
              href: "https://direct.yandex.ru/registered/main.pl?cmd=apiSettings",
              label: "Открыть настройки API",
            }
          : null;
  const businessDescription = `${ws.state.name} — ${ws.state.service} в городе ${ws.state.city}. ${ws.state.benefit}.`;

  useEffect(() => {
    setDestinationUrl(ws.state.website || "");
    setSitePath(
      ws.state.landingMode === "yandex_landing" || !ws.state.website
        ? "yandex"
        : "website",
    );
  }, [ws.id, ws.state.website, ws.state.landingMode]);

  async function saveDestination(mode: "external" | "yandex_landing") {
    let normalized: string;
    try {
      const parsed = new URL(destinationUrl.trim());
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
      normalized = parsed.toString();
    } catch {
      setError("Вставьте полный адрес страницы, начиная с https://");
      return;
    }
    setReading(true);
    setError("");
    try {
      await api(`/businesses/${ws.id}/command`, {
        action: "settings",
        payload: {
          name: ws.state.name,
          category: ws.state.category,
          city: ws.state.city,
          website: normalized,
          landingMode: mode,
          service: ws.state.service,
          benefit: ws.state.benefit,
          price: ws.state.price,
          budget: ws.state.budget,
          targetCpa: ws.state.targetCpa,
          timezone: ws.state.timezone,
          periodStart: ws.state.periodStart,
          periodEnd: ws.state.periodEnd,
        },
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  }
  function chooseSitePath(next: "website" | "yandex") {
    setSitePath(next);
    setDestinationUrl(
      next === "yandex"
        ? ws.state.landingMode === "yandex_landing"
          ? ws.state.website || ""
          : ""
        : ws.state.landingMode !== "yandex_landing"
          ? ws.state.website || ""
          : "",
    );
    setError("");
    setMetricaSetup(null);
  }
  async function read(kind: string) {
    setReading(true);
    setError("");
    try {
      const result = await api(
        `/businesses/${ws.id}/provider/${kind}${login ? "?login=" + encodeURIComponent(login) : ""}`,
      );
      if (kind === "clients") refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  }
  async function loadCounters() {
    setReading(true);
    setError("");
    try {
      const result = await api(`/businesses/${ws.id}/provider/counters`);
      setCounters(result.counters || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  }
  async function loadGoals(id: string) {
    setCounterId(id);
    setGoalId("");
    if (!id) return setGoals([]);
    setReading(true);
    setError("");
    try {
      const result = await api(
        `/businesses/${ws.id}/provider/goals?counterId=${encodeURIComponent(id)}`,
      );
      setGoals(result.goals || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  }
  async function bindMetrica() {
    setReading(true);
    setError("");
    try {
      await api(`/businesses/${ws.id}/metrica/bind`, { counterId, goalId });
      const setup = await api(`/businesses/${ws.id}/metrica/setup`);
      setMetricaSetup(setup);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  }
  async function loadMetricaSetup() {
    setReading(true);
    setError("");
    try {
      const setup = await api(`/businesses/${ws.id}/metrica/setup`);
      setMetricaSetup(setup);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  }
  async function copyText(
    value: string,
    kind: "counter" | "goal" | "description",
  ) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setError(
        "Браузер не дал доступ к буферу. Выделите и скопируйте код вручную.",
      );
    }
  }
  async function completeYandex(e: React.FormEvent) {
    e.preventDefault();
    setReading(true);
    setError("");
    try {
      await api(`/businesses/${ws.id}/yandex/oauth/complete`, {
        code: yandexCode,
      });
      window.location.href = "/?connected=yandex";
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  }
  const oauthConnect = ws.capabilities.yandex ? (
    <div className="oauth-connect">
      <a
        href={`/auth/yandex/start?businessId=${ws.id}`}
        className="button primary"
        target="_blank"
        rel="noreferrer"
      >
        1. Войти в Яндекс и получить код <ArrowUpRight size={16} />
      </a>
      <form noValidate onSubmit={completeYandex}>
        <label>
          Код подтверждения
          <input
            value={yandexCode}
            onChange={(e) => setYandexCode(e.target.value)}
            placeholder="Вставьте код из новой вкладки"
            autoComplete="one-time-code"
            required
          />
        </label>
        <button
          className="secondary"
          disabled={reading || yandexCode.trim().length < 4}
        >
          2. Завершить подключение
        </button>
      </form>
      <small className="muted">
        В новой вкладке можно выбрать другой аккаунт Яндекса. Код действует
        десять минут — не отправляйте его в чат.
      </small>
    </div>
  ) : (
    <p className="muted">
      Нужны параметры приложения Яндекса в настройках сервера.
    </p>
  );
  return (
    <>
      <div className="connections-grid">
        <section className="card connection">
          <div className="provider-icon yandex">Я</div>
          <div>
            <h2>Яндекс Директ</h2>
            <p>Реклама в поиске и на сайтах партнеров</p>
          </div>
          <Badge
            tone={
              ws.state.mode === "demo"
                ? "amber"
                : retiredSandbox
                  ? "amber"
                  : needsReconnect
                    ? "amber"
                    : directBlocked
                      ? "amber"
                      : directVerified
                        ? "green"
                        : "gray"
            }
          >
            {ws.state.mode === "demo"
              ? "Тестовые данные"
              : retiredSandbox
                ? "Нужно подключить кабинет"
                : needsReconnect
                  ? "Нужно войти"
                  : directBlocked
                    ? "Ожидает доступа"
                    : directVerified
                      ? "Подключен"
                      : "Не подключен"}
          </Badge>
          <div className="connection-body">
            <p>
              {ws.state.mode === "demo"
                ? "В демо используется изолированный тестовый кабинет. Реальные токены и деньги не нужны."
                : linked && !directVerified
                  ? "Код Яндекса сохранён. Пока доступ к API Директа не подтверждён, Ритм не читает и не меняет рекламу."
                  : ws.capabilities.directWritePilot
                    ? "Кабинет готов к чтению данных и созданию выключенных черновиков после проверки плана и отдельного подтверждения."
                    : "Кабинет доступен для чтения. Создание выключенных черновиков закрыто серверным допуском; показы и расходы отключены."}
            </p>
            {ws.state.mode === "demo" ? (
              <div className="connected-line">
                <CheckCircle2 size={17} />
                Симулятор готов к работе
              </div>
            ) : linked ? (
              <>
                {retiredSandbox && (
                  <section
                    className="connection-reconnect"
                    aria-label="Переподключение Яндекс Директа"
                  >
                    <div className="connected-line pending">
                      <Clock3 size={17} />
                      Старое тестовое подключение больше не работает. Подключите
                      обычный кабинет: Ритм сможет читать данные, но рекламу не
                      запустит.
                    </div>
                    {oauthConnect}
                  </section>
                )}
                {needsReconnect && (
                  <div className="connected-line pending">
                    <Clock3 size={17} />
                    {linked.validationMessage ||
                      "Срок доступа закончился. Подключите Яндекс заново."}
                  </div>
                )}
                {linked.clients.length ? (
                  <label>
                    Ваш кабинет
                    <select
                      value={login || linked.clients[0]?.Login}
                      onChange={(e) => setLogin(e.target.value)}
                    >
                      {linked.clients.map((c) => (
                        <option key={c.Login}>{c.Login}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div className="connection-access-help">
                    <div className="connected-line pending">
                      <Clock3 size={17} />
                      {linked.validationMessage ||
                        "Код сохранён. Осталось проверить кабинет Директа."}
                    </div>
                    {directHelp && (
                      <a
                        className="button secondary"
                        href={directHelp.href}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {directHelp.label} <ArrowUpRight size={15} />
                      </a>
                    )}
                  </div>
                )}
                <div className="button-row">
                  {!linked.clients.length &&
                    !needsReconnect &&
                    !retiredSandbox && (
                      <button
                        className="secondary"
                        disabled={reading}
                        onClick={() => read("clients")}
                      >
                        {reading ? "Проверяем доступ…" : "Проверить доступ"}
                      </button>
                    )}
                  <button
                    className="secondary"
                    disabled={
                      reading ||
                      !linked.clients.length ||
                      needsReconnect ||
                      retiredSandbox
                    }
                    onClick={() => read("campaigns")}
                  >
                    Проверить кампании
                  </button>
                  <button
                    className="secondary"
                    disabled={
                      reading ||
                      !linked.clients.length ||
                      needsReconnect ||
                      retiredSandbox
                    }
                    onClick={() => read("report")}
                  >
                    Получить отчет
                  </button>
                  <button
                    className="danger-button"
                    disabled={reading || busy}
                    onClick={disconnect}
                  >
                    Отключить и отозвать токен
                  </button>
                </div>
                <div
                  className="direct-connection-status"
                  aria-label="Готовность Яндекс Директа"
                >
                  <div className={linked ? "ready" : "pending"}>
                    <CheckCircle2 size={15} />
                    <span>Связь с Яндексом</span>
                    <b>{linked ? "подключена" : "не подключена"}</b>
                  </div>
                  <div className={linked.clients.length ? "ready" : "pending"}>
                    <CheckCircle2 size={15} />
                    <span>Кабинет</span>
                    <b>{linked.clients.length ? "проверен" : "не проверен"}</b>
                  </div>
                  <div
                    className={
                      ws.capabilities.directWritePilot ? "ready" : "pending"
                    }
                  >
                    <ShieldCheck size={15} />
                    <span>Подготовка запуска</span>
                    <b>
                      {ws.capabilities.directWritePilot
                        ? "разрешены"
                        : "закрыты"}
                    </b>
                  </div>
                </div>
                {needsReconnect && !retiredSandbox && oauthConnect}
              </>
            ) : (
              oauthConnect
            )}
          </div>
        </section>
        <section className="card connection destination-connection">
          <div className="provider-icon metrica">
            <PanelsTopLeft size={24} />
          </div>
          <div>
            <h2>Куда вести клиентов</h2>
            <p>Выберите обычный сайт или страницу Яндекса</p>
          </div>
          <Badge
            tone={
              ws.state.website &&
              (ws.state.landingMode === "yandex_landing" || ws.state.counterId)
                ? "green"
                : "gray"
            }
          >
            {ws.state.landingMode === "yandex_landing" && ws.state.website
              ? "Страница сохранена"
              : ws.state.counterId
                ? "Обращение выбрано"
                : "Нужно настроить"}
          </Badge>
          <div className="connection-body">
            {ws.state.mode === "demo" ? (
              ws.state.counterId ? (
                <div className="connected-line">
                  <CheckCircle2 size={17} />
                  Тестовые обращения подключены
                </div>
              ) : (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={connectDemo}
                >
                  <Plus size={16} />
                  Подключить тестовые обращения
                </button>
              )
            ) : (
              <>
                <fieldset className="site-path-selector">
                  <legend>У вас есть сайт?</legend>
                  <label className={sitePath === "website" ? "selected" : ""}>
                    <input
                      type="radio"
                      name="site-path"
                      value="website"
                      checked={sitePath === "website"}
                      onChange={() => chooseSitePath("website")}
                    />
                    <span>
                      <b>Есть сайт</b>
                      <small>Подключим Метрику и выберем обращение</small>
                    </span>
                  </label>
                  <label className={sitePath === "yandex" ? "selected" : ""}>
                    <input
                      type="radio"
                      name="site-path"
                      value="yandex"
                      checked={sitePath === "yandex"}
                      onChange={() => chooseSitePath("yandex")}
                    />
                    <span>
                      <b>Сайта нет</b>
                      <small>Создадите страницу в Директе без сайта</small>
                    </span>
                  </label>
                </fieldset>

                {sitePath === "yandex" ? (
                  <section
                    className="no-site-setup"
                    aria-labelledby="no-site-title"
                  >
                    <header>
                      <span aria-hidden="true">
                        <PanelsTopLeft size={20} />
                      </span>
                      <div>
                        <h3 id="no-site-title">Создайте страницу в Яндексе</h3>
                        <p>
                          Скопируйте готовое описание, добавьте телефон,
                          Telegram или WhatsApp и опубликуйте страницу.
                        </p>
                      </div>
                    </header>
                    <ol className="no-site-steps">
                      <li>
                        <span>1</span>В Директе выберите «Продвижение бизнеса
                        без сайта».
                      </li>
                      <li>
                        <span>2</span>
                        Вставьте описание и добавьте способ связи.
                      </li>
                      <li>
                        <span>3</span>
                        Опубликуйте страницу и вернитесь сюда со ссылкой.
                      </li>
                    </ol>
                    <div className="business-description-copy">
                      <div>
                        <small>Описание для страницы</small>
                        <p>{businessDescription}</p>
                      </div>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          copyText(businessDescription, "description")
                        }
                      >
                        {copied === "description" ? (
                          <Check size={15} />
                        ) : (
                          <Copy size={15} />
                        )}
                        {copied === "description"
                          ? "Скопировано"
                          : "Скопировать"}
                      </button>
                    </div>
                    <a
                      className="button primary no-site-yandex-link"
                      href="https://direct.yandex.ru/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Открыть Яндекс Директ <ArrowUpRight size={16} />
                    </a>
                    <form
                      className="destination-url-form"
                      noValidate
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveDestination("yandex_landing");
                      }}
                    >
                      <label htmlFor="yandex-landing-url">
                        Ссылка на опубликованную страницу
                        <input
                          id="yandex-landing-url"
                          type="url"
                          inputMode="url"
                          value={destinationUrl}
                          onChange={(event) =>
                            setDestinationUrl(event.target.value)
                          }
                          placeholder="https://…"
                          aria-describedby="yandex-landing-help"
                        />
                      </label>
                      <button
                        className="secondary"
                        disabled={reading || !destinationUrl.trim()}
                      >
                        {reading ? "Сохраняем…" : "Сохранить ссылку"}
                      </button>
                      <small id="yandex-landing-help">
                        Код устанавливать не нужно. После запуска Ритм возьмёт
                        обращения из отчёта Директа.
                      </small>
                    </form>
                    {ws.state.landingMode === "yandex_landing" &&
                      ws.state.website && (
                        <div className="destination-saved" role="status">
                          <CheckCircle2 size={17} />
                          <span>
                            <b>Страница сохранена</b>
                            <a
                              href={ws.state.website}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Открыть и проверить <ArrowUpRight size={14} />
                            </a>
                          </span>
                        </div>
                      )}
                    <p className="no-site-limit">
                      Страницу нужно опубликовать в Яндексе — Ритм не может
                      сделать это вместо вас. После публикации ссылка появится в
                      рекламном плане.
                    </p>
                  </section>
                ) : (
                  <div className="metrica-picker">
                    {(!ws.state.website ||
                      ws.state.landingMode === "yandex_landing") && (
                      <form
                        className="destination-url-form"
                        noValidate
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveDestination("external");
                        }}
                      >
                        <label htmlFor="business-website-url">
                          Адрес вашего сайта
                          <input
                            id="business-website-url"
                            type="url"
                            inputMode="url"
                            value={destinationUrl}
                            onChange={(event) =>
                              setDestinationUrl(event.target.value)
                            }
                            placeholder="https://example.ru"
                          />
                        </label>
                        <button
                          className="primary"
                          disabled={reading || !destinationUrl.trim()}
                        >
                          {reading ? "Сохраняем…" : "Сохранить сайт"}
                        </button>
                      </form>
                    )}
                    {ws.state.website &&
                      ws.state.landingMode !== "yandex_landing" && (
                        <>
                          <p>
                            Выберите в Метрике действие, которое означает
                            обращение: отправку формы, звонок или запись.
                          </p>
                          <button
                            className="secondary"
                            disabled={!linked || reading || needsReconnect}
                            aria-describedby={
                              linked ? undefined : "metrica-needs-direct"
                            }
                            onClick={loadCounters}
                          >
                            Найти сайт в Метрике
                          </button>
                          {!linked && (
                            <p
                              id="metrica-needs-direct"
                              className="connection-step-hint"
                            >
                              Сначала подключите Директ. Так Ритм свяжет расходы
                              с обращениями на сайте.
                            </p>
                          )}
                          {!!counters.length && (
                            <label>
                              Ваш сайт
                              <select
                                value={counterId}
                                onChange={(e) => loadGoals(e.target.value)}
                              >
                                <option value="">Выберите сайт</option>
                                {counters.map((counter) => (
                                  <option key={counter.id} value={counter.id}>
                                    {counter.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          {!!goals.length && (
                            <label>
                              Что считать обращением?
                              <select
                                value={goalId}
                                onChange={(e) => setGoalId(e.target.value)}
                              >
                                <option value="">Выберите действие</option>
                                {goals.map((goal) => (
                                  <option key={goal.id} value={goal.id}>
                                    {goal.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          {counterId && goalId && (
                            <button
                              className="primary"
                              disabled={reading || needsReconnect}
                              onClick={bindMetrica}
                            >
                              Сохранить обращение
                            </button>
                          )}
                          {ws.state.counterId && ws.state.goalId && (
                            <div className="metrica-actions">
                              <button
                                className="secondary"
                                disabled={reading || needsReconnect}
                                onClick={loadMetricaSetup}
                              >
                                Получить код для сайта
                              </button>
                              <button
                                className="secondary"
                                disabled={reading || needsReconnect}
                                onClick={() => read("metrica-stats")}
                              >
                                Проверить обращение
                              </button>
                            </div>
                          )}
                          {metricaSetup && (
                            <section
                              className="metrica-setup"
                              aria-live="polite"
                            >
                              <div className="metrica-setup-heading">
                                <div>
                                  <small>Что сделать на сайте</small>
                                  <b>{metricaSetup.counter.name}</b>
                                </div>
                                <Badge
                                  tone={metricaSetup.ready ? "green" : "amber"}
                                >
                                  {metricaSetup.ready
                                    ? "Готово к установке"
                                    : "Нужна проверка"}
                                </Badge>
                              </div>
                              <ul className="metrica-checks">
                                {metricaSetup.checks.map((check) => (
                                  <li key={check.code} className={check.status}>
                                    {check.status === "ok" ? (
                                      <CheckCircle2 size={15} />
                                    ) : (
                                      <HelpCircle size={15} />
                                    )}
                                    {check.message}
                                  </li>
                                ))}
                              </ul>
                              <div className="metrica-code-block">
                                <div>
                                  <b>Добавьте этот код на все страницы сайта</b>
                                  <button
                                    type="button"
                                    className="text-button"
                                    onClick={() =>
                                      copyText(
                                        metricaSetup.installation.counterCode,
                                        "counter",
                                      )
                                    }
                                  >
                                    {copied === "counter" ? (
                                      <Check size={14} />
                                    ) : (
                                      <Copy size={14} />
                                    )}
                                    {copied === "counter"
                                      ? "Скопировано"
                                      : "Копировать"}
                                  </button>
                                </div>
                                <pre>
                                  {metricaSetup.installation.counterCode}
                                </pre>
                              </div>
                              {metricaSetup.installation.goalCall && (
                                <div className="metrica-code-block compact">
                                  <div>
                                    <b>
                                      Добавьте этот код после успешного
                                      обращения
                                    </b>
                                    <button
                                      type="button"
                                      className="text-button"
                                      onClick={() =>
                                        copyText(
                                          metricaSetup.installation.goalCall!,
                                          "goal",
                                        )
                                      }
                                    >
                                      {copied === "goal" ? (
                                        <Check size={14} />
                                      ) : (
                                        <Copy size={14} />
                                      )}
                                      {copied === "goal"
                                        ? "Скопировано"
                                        : "Копировать"}
                                    </button>
                                  </div>
                                  <pre>
                                    {metricaSetup.installation.goalCall}
                                  </pre>
                                </div>
                              )}
                              <p>{metricaSetup.installation.placement}</p>
                            </section>
                          )}
                        </>
                      )}
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>
      <div className="info-box">
        <Plug size={21} />
        <span>
          <b>Подключение к Яндексу</b>
          <br />
          Ритм подключается к Яндексу напрямую. Реклама не запустится без вашей
          проверки и отдельного подтверждения.
        </span>
      </div>
      {visibleError && (
        <div className="error" role="alert">
          {visibleError}
        </div>
      )}
    </>
  );
}
type FormData = {
  name: string;
  category: string;
  city: string;
  website: string;
  landingMode: "external" | "yandex_landing";
  service: string;
  benefit: string;
  price: number;
  budget: number;
  targetCpa: number;
  timezone: string;
  periodStart: string;
  periodEnd: string;
};
type EditableBusinessFact =
  "name" | "category" | "city" | "service" | "benefit" | "budget" | "website";
function formFrom(s: Business): FormData {
  return {
    name: s.name,
    category: s.category,
    city: s.city,
    website: s.website,
    landingMode: s.landingMode || "external",
    service: s.service,
    benefit: s.benefit,
    price: s.price,
    budget: s.budget / 100,
    targetCpa: s.targetCpa / 100,
    timezone: s.timezone,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
  };
}
function Settings({
  ws,
  edit,
  add,
}: {
  ws: Workspace;
  edit: () => void;
  add: () => void;
}) {
  return (
    <section className="card settings-card">
      <div className="card-heading">
        <div>
          <h2>Профиль бизнеса</h2>
          <p>Рита использует эти факты в плане и текстах объявлений</p>
        </div>
        <span className="business-avatar big">{ws.state.name[0]}</span>
      </div>
      <div className="assistant-profile-summary">
        <div>
          <span>Бизнес</span>
          <b>{ws.state.name}</b>
        </div>
        <div>
          <span>Сфера</span>
          <b>{ws.state.category}</b>
        </div>
        <div>
          <span>Город</span>
          <b>{ws.state.city}</b>
        </div>
        <div>
          <span>Продвигаем</span>
          <b>{ws.state.service}</b>
        </div>
        <div className="wide">
          <span>Почему выбирают вас</span>
          <b>{ws.state.benefit}</b>
        </div>
        <div>
          <span>Бюджет</span>
          <b>{money(ws.state.budget)}</b>
        </div>
        <div>
          <span>Сайт</span>
          <b>{ws.state.website || "Пока не указан"}</b>
        </div>
      </div>
      <div className="info-box assistant-settings-note">
        <Sparkles size={19} />
        <span>
          Чтобы изменить данные, расскажите Рите всё обычными словами. После
          подтверждения она пересоберёт рекламный план.
        </span>
      </div>
      <div className="settings-footer">
        <button type="button" className="primary" onClick={edit}>
          <Sparkles size={16} />
          Изменить с Ритой
        </button>
        <button type="button" className="text-button" onClick={add}>
          <Plus size={16} />
          Добавить другой бизнес
        </button>
      </div>
    </section>
  );
}
function Modal({
  title,
  close,
  children,
  error,
  className = "",
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
  error?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`.trim()}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="modal-inner">
        <div className="modal-heading">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            aria-label="Закрыть окно"
            className="icon-button"
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {children}
      </div>
    </dialog>
  );
}
function BudgetModal({
  ws,
  busy,
  close,
  save,
  error,
}: {
  ws: Workspace;
  busy: boolean;
  close: () => void;
  save: (b: number) => void;
  error?: string;
}) {
  const [b, setB] = useState(ws.state.budget / 100);
  return (
    <Modal title="Бюджет в вашем ритме" close={close} error={error}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save(Math.round(b * 100));
        }}
      >
        <p className="modal-copy">
          Лимит на {date(ws.state.periodStart)} — {date(ws.state.periodEnd)}.
          Уже потрачено {money(ws.totals.spent)}.
        </p>
        <label>
          Общий бюджет, ₽
          <input
            autoFocus
            type="number"
            required
            min={Math.ceil(ws.totals.spent / 90)}
            max={1000000}
            value={b}
            onChange={(e) => setB(Number(e.target.value))}
          />
        </label>
        <div className="info-box">
          <ShieldCheck size={20} />
          <span>
            Мы не просим вас задавать ставки или цену обращения. Сервис сам
            установит осторожный ориентир и уточнит его по подтвержденным
            обращениям.
          </span>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={close}>
            Отмена
          </button>
          <button className="primary" disabled={busy}>
            Сохранить бюджет
          </button>
        </div>
      </form>
    </Modal>
  );
}
function BusinessModal({
  busy,
  close,
  save,
  error,
  initial,
  ownerName,
}: {
  busy: boolean;
  close: () => void;
  save: (v: Record<string, unknown>) => void;
  error?: string;
  initial?: Business;
  ownerName?: string;
}) {
  const now = new Date(),
    start = now.toISOString().slice(0, 10),
    end = new Date(now.getTime() + 29 * 86400000).toISOString().slice(0, 10);
  const [form, set] = useState<FormData>(
      initial
        ? formFrom(initial)
        : {
            name: "",
            category: "",
            city: "",
            website: "",
            landingMode: "external",
            service: "",
            benefit: "",
            price: 0,
            budget: 0,
            targetCpa: 450,
            timezone: "Asia/Yekaterinburg",
            periodStart: start,
            periodEnd: end,
          },
    ),
    [draft, setDraft] = useState(""),
    [thinking, setThinking] = useState(false),
    [responseSlow, setResponseSlow] = useState(false),
    [assistantProblem, setAssistantProblem] = useState(false),
    [editingFact, setEditingFact] = useState<EditableBusinessFact | null>(null),
    [factDraft, setFactDraft] = useState(""),
    [factError, setFactError] = useState(""),
    [messages, setMessages] = useState([
      {
        role: "assistant",
        text: initial
          ? `Я Рита. Сейчас я знаю ваш бизнес как «${initial.name}». Расскажите обычными словами, что нужно изменить — я обновлю профиль и рекламный план.`
          : `Здравствуйте${ownerName ? `, ${ownerName}` : ""}! Я Рита. Расскажите о бизнесе своими словами: чем занимаетесь, где работаете и какой бюджет готовы выделить. Я уточню только то, чего не хватит, а затем соберу первый план.`,
      },
    ]);
  const chatRef = useRef<HTMLDivElement>(null);
  const ready = Boolean(
    form.name &&
    form.category &&
    form.city &&
    form.service &&
    form.benefit &&
    form.budget,
  );
  const facts: Array<{
    key: Exclude<EditableBusinessFact, "website">;
    label: string;
    value: string;
  }> = [
    { key: "name", label: "Название", value: form.name },
    { key: "category", label: "Сфера", value: form.category },
    { key: "city", label: "Город", value: form.city },
    { key: "service", label: "Что продвигаем", value: form.service },
    { key: "benefit", label: "Почему выбирают вас", value: form.benefit },
    {
      key: "budget",
      label: "Бюджет на месяц",
      value: form.budget ? money(form.budget * 100) : "",
    },
  ];
  const knownFacts = facts.filter((fact) => fact.value).length;
  const growthStage = ready ? 3 : knownFacts >= 3 ? 2 : knownFacts ? 1 : 0;
  const assistantStatus = busy
    ? initial
      ? "Обновляет план"
      : "Готовит план"
    : thinking
      ? "Печатает"
      : assistantProblem
        ? "Не удалось ответить"
        : ready
          ? "Ждёт подтверждения"
          : "Готова ответить";
  const assistantStatusKind = busy
    ? "planning"
    : thinking
      ? "typing"
      : assistantProblem
        ? "problem"
        : ready
          ? "waiting"
          : "ready";

  function startFactEdit(key: EditableBusinessFact) {
    setEditingFact(key);
    setFactError("");
    setFactDraft(key === "budget" ? String(form.budget || "") : form[key]);
  }

  function saveFactEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editingFact) return;
    if (editingFact === "budget") {
      const budget = Number(factDraft.replace(",", "."));
      if (!Number.isFinite(budget) || budget <= 0) {
        setFactError("Укажите бюджет больше нуля.");
        return;
      }
      set((current) => ({ ...current, budget }));
    } else {
      const value = factDraft.trim();
      if (!value) {
        setFactError("Заполните это поле или отмените изменение.");
        return;
      }
      set((current) => ({
        ...current,
        [editingFact]: value,
        ...(editingFact === "website" ? { landingMode: "external" } : {}),
      }));
    }
    setEditingFact(null);
    setFactError("");
  }

  useEffect(() => {
    if (chatRef.current)
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, thinking]);

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || thinking) return;
    setDraft("");
    setMessages((items) => [...items, { role: "user", text: message }]);
    setThinking(true);
    setResponseSlow(false);
    setAssistantProblem(false);
    const slowTimer = window.setTimeout(() => setResponseSlow(true), 4_000);
    try {
      const result = await api(
        "/assistant/onboarding",
        {
          message,
          profile: {
            name: form.name || undefined,
            category: form.category || undefined,
            city: form.city || undefined,
            website: form.website || undefined,
            service: form.service || undefined,
            benefit: form.benefit || undefined,
            price: form.price || undefined,
            budget: form.budget || undefined,
          },
        },
        "POST",
        undefined,
        12_000,
      );
      set((current) => ({ ...current, ...result.profile }));
      setMessages((items) => [
        ...items,
        { role: "assistant", text: result.reply },
      ]);
    } catch {
      setAssistantProblem(true);
      setMessages((items) => [
        ...items,
        {
          role: "assistant",
          text: "Не получилось разобрать сообщение. Попробуйте ещё раз — я, Рита, не потеряю уже рассказанные данные.",
        },
      ]);
    } finally {
      window.clearTimeout(slowTimer);
      setResponseSlow(false);
      setThinking(false);
    }
  }
  return (
    <Modal
      title={initial ? "Обновить бизнес с Ритой" : "Познакомьтесь с Ритой"}
      close={close}
      error={error}
      className="assistant-modal"
    >
      <div className="business-assistant">
        <section className="rita-conversation" aria-label="Диалог с Ритой">
          <header className="rita-identity">
            <span className="rita-avatar" aria-hidden="true">
              Р
            </span>
            <div>
              <b>Рита</b>
              <span>Нейросетевой помощник по рекламе</span>
            </div>
            <span
              className={`rita-status ${assistantStatusKind}`}
              role="status"
              aria-live="polite"
            >
              <i aria-hidden="true" />
              {assistantStatus}
            </span>
          </header>

          <div
            ref={chatRef}
            className="onboarding-chat"
            aria-live="polite"
            aria-busy={thinking || busy}
          >
            {messages.map((item, index) => (
              <div className={`onboarding-message ${item.role}`} key={index}>
                {item.role === "assistant" && (
                  <span
                    className="onboarding-message-avatar"
                    aria-hidden="true"
                  >
                    Р
                  </span>
                )}
                <div>
                  <small>{item.role === "assistant" ? "Рита" : "Вы"}</small>
                  <p>{item.text}</p>
                </div>
              </div>
            ))}
            {thinking && (
              <div className="onboarding-message assistant">
                <span className="onboarding-message-avatar" aria-hidden="true">
                  Р
                </span>
                <div>
                  <small>Рита печатает</small>
                  <p className="rita-typing-bubble" aria-label="Рита печатает">
                    <span className="rita-typing-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  </p>
                  {responseSlow && (
                    <span className="rita-wait-note" role="status">
                      Ответ занимает чуть дольше обычного — ещё несколько
                      секунд.
                    </span>
                  )}
                </div>
              </div>
            )}
            {busy && (
              <div className="onboarding-message assistant">
                <span className="onboarding-message-avatar" aria-hidden="true">
                  Р
                </span>
                <div>
                  <small>Рита готовит план</small>
                  <p className="rita-plan-progress">
                    <LoaderCircle className="spin" size={15} />
                    <span>
                      {initial
                        ? "Сохраняю изменения и обновляю план."
                        : "Сохраняю профиль и открываю первый план."}
                      <small>Обычно это занимает несколько секунд.</small>
                    </span>
                  </p>
                </div>
              </div>
            )}
          </div>

          <form
            className="onboarding-chat-compose"
            noValidate
            onSubmit={sendMessage}
          >
            <label className="sr-only" htmlFor="rita-message">
              Сообщение Рите
            </label>
            <textarea
              id="rita-message"
              className="resize-none"
              autoFocus
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={3}
              placeholder={
                ready
                  ? "Например: бюджет нужно изменить на 40 000 ₽…"
                  : "Например: у меня студия маникюра в Екатеринбурге…"
              }
            />
            <button
              className="primary"
              disabled={busy || thinking || !draft.trim()}
              aria-busy={thinking}
            >
              {thinking ? "Рита отвечает…" : "Отправить"}
              {!thinking && <ArrowRight size={15} />}
            </button>
          </form>
          <p className="rita-compose-hint">
            Enter — отправить · Shift + Enter — новая строка
          </p>
        </section>

        <aside
          className="rita-understanding"
          aria-label="Что Рита поняла о бизнесе"
        >
          {!initial && (
            <section className="rita-growth" aria-label="Путь запуска рекламы">
              <div>
                <b>Дерево рекламы</b>
                <span>
                  {ready
                    ? "Бизнес описан — дерево окрепло."
                    : "Первый рост начинается с рассказа о бизнесе."}
                </span>
              </div>
              <ol>
                {rhythmGrowthImages.map((image, index) => (
                  <li
                    className={
                      index < growthStage
                        ? "done"
                        : index === growthStage
                          ? "current"
                          : "pending"
                    }
                    key={image}
                  >
                    <img src={image} alt="" />
                  </li>
                ))}
              </ol>
            </section>
          )}
          <header>
            <div>
              <h3>Что Рита поняла</h3>
              <p>
                {knownFacts} из {facts.length} обязательных фактов
              </p>
            </div>
            <span className="rita-progress-value">
              {Math.round((knownFacts / facts.length) * 100)}%
            </span>
          </header>
          <div className="rita-progress" aria-hidden="true">
            <i
              style={{
                transform: `scaleX(${knownFacts / facts.length})`,
              }}
            />
          </div>
          <dl className="rita-facts">
            {facts.map((fact) => (
              <div
                className={fact.value ? "is-known" : "is-missing"}
                key={fact.key}
              >
                <dt>{fact.label}</dt>
                {editingFact === fact.key ? (
                  <form
                    className="rita-fact-editor"
                    noValidate
                    onSubmit={saveFactEdit}
                  >
                    <label
                      className="sr-only"
                      htmlFor={`rita-fact-${fact.key}`}
                    >
                      {fact.label}
                    </label>
                    <input
                      autoFocus
                      id={`rita-fact-${fact.key}`}
                      type={fact.key === "budget" ? "number" : "text"}
                      min={fact.key === "budget" ? 1 : undefined}
                      inputMode={fact.key === "budget" ? "numeric" : undefined}
                      value={factDraft}
                      onChange={(event) => {
                        setFactDraft(event.target.value);
                        if (factError) setFactError("");
                      }}
                      aria-invalid={!!factError}
                      aria-describedby={
                        factError ? "rita-fact-error" : undefined
                      }
                    />
                    <button type="submit">Сохранить</button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingFact(null);
                        setFactError("");
                      }}
                    >
                      Отмена
                    </button>
                    {factError && (
                      <p
                        id="rita-fact-error"
                        className="field-error"
                        role="alert"
                      >
                        {factError}
                      </p>
                    )}
                  </form>
                ) : (
                  <>
                    <dd>{fact.value || "Рита уточнит в диалоге"}</dd>
                    <button
                      className="rita-fact-edit"
                      type="button"
                      onClick={() => startFactEdit(fact.key)}
                    >
                      Исправить
                    </button>
                  </>
                )}
                <span aria-hidden="true">
                  {fact.value ? <Check size={14} /> : null}
                </span>
              </div>
            ))}
            <div
              className={
                form.website ? "is-known optional" : "is-missing optional"
              }
            >
              <dt>
                Сайт <small>необязательно</small>
              </dt>
              {editingFact === "website" ? (
                <form
                  className="rita-fact-editor"
                  noValidate
                  onSubmit={saveFactEdit}
                >
                  <label className="sr-only" htmlFor="rita-fact-website">
                    Сайт
                  </label>
                  <input
                    autoFocus
                    id="rita-fact-website"
                    type="url"
                    value={factDraft}
                    onChange={(event) => {
                      setFactDraft(event.target.value);
                      if (factError) setFactError("");
                    }}
                    placeholder="https://example.ru"
                    aria-invalid={!!factError}
                    aria-describedby={factError ? "rita-fact-error" : undefined}
                  />
                  <button type="submit">Сохранить</button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingFact(null);
                      setFactError("");
                    }}
                  >
                    Отмена
                  </button>
                  {factError && (
                    <p
                      id="rita-fact-error"
                      className="field-error"
                      role="alert"
                    >
                      {factError}
                    </p>
                  )}
                </form>
              ) : (
                <>
                  <dd>{form.website || "Можно добавить позже"}</dd>
                  <button
                    className="rita-fact-edit"
                    type="button"
                    onClick={() => startFactEdit("website")}
                  >
                    {form.website ? "Исправить" : "Добавить"}
                  </button>
                </>
              )}
              <span aria-hidden="true">
                {form.website ? <Check size={14} /> : null}
              </span>
            </div>
          </dl>
          <div className={`rita-confirmation ${ready ? "is-ready" : ""}`}>
            {ready ? (
              <>
                <CheckCircle2 size={18} />
                <p>
                  <b>Профиль собран</b>
                  <span>
                    Проверьте факты. После подтверждения план откроется через
                    несколько секунд.
                  </span>
                </p>
              </>
            ) : (
              <>
                <Sparkles size={18} />
                <p>
                  <b>Продолжайте разговор</b>
                  <span>Рита спросит только о недостающих фактах.</span>
                </p>
              </>
            )}
          </div>
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              save({ ...form, budget: Math.round(form.budget * 100) });
            }}
          >
            <button
              className="primary rita-confirm-button"
              disabled={busy || thinking || !ready}
              aria-busy={busy}
            >
              {busy ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Sparkles size={15} />
              )}
              {busy
                ? initial
                  ? "Обновляю план…"
                  : "Создаю план…"
                : initial
                  ? "Обновить рекламный план"
                  : "Создать рекламный план"}
            </button>
          </form>
        </aside>
      </div>
    </Modal>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
