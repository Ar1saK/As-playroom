// ETC料金リストの写真を Claude（Haiku）で読み取る。
// API キーはこの端末にだけ保存し、同期もリポジトリへの保存もしない。
const SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.135.0/+esm';
const KEY = 'kakeibo-apikey';
const MODEL = 'claude-haiku-5-5';

export const getKey = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
export const setKey = (k) => { try { k ? localStorage.setItem(KEY, k) : localStorage.removeItem(KEY); } catch {} };

// 写真を長辺 1568px の JPEG に縮めて base64 にする（送るサイズと費用を抑える）
async function toJpeg(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

const SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY/MM/DD' },
          time: { type: 'string', description: 'HH:MM' },
          amount: { type: 'integer', description: '金額（円）' },
        },
        required: ['date', 'time', 'amount'],
        additionalProperties: false,
      },
    },
    unreadable: { type: 'integer', description: '読み取れなかった行の数' },
  },
  required: ['rows', 'unreadable'],
  additionalProperties: false,
};

// 返り値は parseEtcRows にそのまま渡せる「YYYY/MM/DD HH:MM 金額」の行
export async function readEtcPhotos(files, onStatus = () => {}) {
  onStatus('写真を準備中…');
  const images = await Promise.all([...files].map(toJpeg));
  onStatus('読み取り中…（10〜30秒ほど）');
  const { default: Anthropic } = await import(SDK);
  const client = new Anthropic({ apiKey: getKey(), dangerouslyAllowBrowser: true });
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          ...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
          { type: 'text', text: 'これは車のナビ画面に表示された「ETC料金リスト」の写真です。' +
            '写っている表のすべての行について、日付・時刻・金額を読み取ってください。' +
            '写真どうしで同じ行が写っていてもそのまま含めてかまいません。' +
            '右側の「ETC料金履歴詳細」の欄は無視してください。読めない行は rows に入れず unreadable に数えてください。' },
        ],
      }],
    });
    if (res.stop_reason === 'refusal') throw new Error('読み取りを断られました。写真を変えて試してください');
    const text = res.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('読み取り結果が空でした');
    const out = JSON.parse(text);
    return {
      text: out.rows.map((r) => `${r.date} ${r.time} ${r.amount}`).join('\n'),
      unreadable: out.unreadable,
    };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('API キーが正しくありません（設定で確認してください）');
    if (e instanceof Anthropic.RateLimitError) throw new Error('混み合っています。少し待ってからもう一度試してください');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('通信できませんでした。電波を確認してください');
    if (e instanceof Anthropic.APIError && /credit/i.test(e.message)) throw new Error('API のクレジットが足りません（Anthropic のサイトで追加してください）');
    throw e;
  }
}
