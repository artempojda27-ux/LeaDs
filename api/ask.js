// Vercel подхватывает файлы в /api как serverless-функции сама, без настройки
// фреймворка — работает даже при Framework preset: Other.
//
// CommonJS (module.exports), не ES-модуль — в проекте нет package.json
// с "type": "module", поэтому Vercel по умолчанию ждёт этот синтаксис.
//
// Ключ ANTHROPIC_API_KEY задаётся в Vercel → Settings → Environment Variables,
// НЕ в index.html.

const DEFAULT_PROMPT = `Ты — полноценный ИИ-помощник внутри рабочей консоли оператора холодных контактов.
Можешь свободно разговаривать на любые темы — погода, общие вопросы, что угодно,
как обычный собеседник. Отвечай на русском, живо и по делу, без канцелярита.
Когда вопрос касается списка лидов ниже — используй его: находи элементы по имени,
давай конкретные советы по звонкам и переписке. Если элемента нет в списке — так и
скажи, не выдумывай данные о лидах. Вне темы лидов — просто помогай как обычный ИИ.`;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { question, history, leads, customContext } = req.body || {};
  if (!question) {
    res.status(400).json({ error: "question обязателен" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY не задан в Vercel → Settings → Environment Variables" });
    return;
  }

  const leadsList = Array.isArray(leads) && leads.length
    ? leads.map(l => `- ${l.name} (${l.niche || "—"}), статус: ${l.status || "новый"}${l.note ? `, заметка: ${l.note}` : ""}`).join("\n")
    : "Список пуст или не передан.";

  // customContext переопределяет дефолтный промпт целиком, если задан —
  // это то самое поле, которое пользователь редактирует в консоли (⚙).
  const basePrompt = (customContext && customContext.trim()) ? customContext.trim() : DEFAULT_PROMPT;

  const system = `${basePrompt}

Список (первые ${leads?.length || 0}):
${leadsList}`;

  // Защита от истории с нарушенным чередованием ролей — Anthropic API
  // требует строгое user/assistant/user/... и первым обязательно user.
  // Если что-то пошло не так на клиенте (например, два подряд одной роли),
  // API вернёт 400 — раньше это могло тонуть в "Пустой ответ".
  let cleanHistory = (Array.isArray(history) ? history.filter(m => m.role === "user" || m.role === "assistant") : []);
  cleanHistory = cleanHistory.filter((m, i) => i === 0 || m.role !== cleanHistory[i - 1].role);
  while (cleanHistory.length && cleanHistory[0].role !== "user") cleanHistory.shift();

  const messages = [...cleanHistory, { role: "user", content: question }];

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 800,
        system,
        messages
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      res.status(502).json({ error: `Claude API error: ${errText}` });
      return;
    }

    const data = await r.json();
    const text = data.content?.[0]?.text;
    if (!text) {
      // Раньше тут молча подставлялось "Пустой ответ" — теперь видно,
      // что реально вернул Claude, чтобы не гадать в следующий раз.
      res.status(200).json({
        answer: `[Пустой ответ от Claude] stop_reason: ${data.stop_reason || "?"}, content: ${JSON.stringify(data.content)}`
      });
      return;
    }
    res.status(200).json({ answer: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
