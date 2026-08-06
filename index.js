const express = require('express')
const https = require('https')

const app = express()
app.use(express.json({ limit: '256kb' }))
const dailyCache = new Map()

function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date())
}

function requestOpenAI(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/responses', method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
      }, timeout: 50000
    }, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(raw)
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(json.error?.message || 'OpenAI 请求失败'))
          resolve(json)
        } catch (_) { reject(new Error('OpenAI 返回格式异常')) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('OpenAI 请求超时')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function cleanStocks(stocks) {
  return (Array.isArray(stocks) ? stocks : []).slice(0, 20).map(s => ({
    code: String(s.id || ''), name: String(s.name || ''), date: String(s.date || ''), price: String(s.price || ''),
    change: String(s.change || ''), turnover: String(s.turnover || ''), amount: String(s.amount || ''),
    netBuy: String(s.netBuy || ''), score: Number(s.score || 0), rank: String(s.rank || ''),
    theme: String(s.theme || ''), style: String(s.style || ''), summary: String(s.summary || '')
  }))
}

app.get('/health', (_, res) => res.json({ ok: true }))

app.post('/api/daily-analysis', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error('服务未配置 OPENAI_API_KEY')
    const date = today()
    if (dailyCache.has(date)) return res.json({ analysis: dailyCache.get(date), cached: true })
    const stocks = cleanStocks(req.body?.stocks)
    if (!stocks.length) throw new Error('没有可分析的股票数据')
    const prompt = `你是A股复盘助手。根据以下当日结构化数据，生成审慎、简洁的中文复盘。不得承诺收益、不得给出买卖指令，必须强调风险。只输出 JSON，不要 markdown。JSON 格式：{"overview":"不超过180字","highlights":["不超过3条"],"risks":["不超过3条"],"watchlist":["不超过3条"]}。数据：${JSON.stringify(stocks)}`
    const response = await requestOpenAI({ model: process.env.OPENAI_MODEL || 'gpt-5', input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }], max_output_tokens: 900, store: false })
    const parsed = JSON.parse(String(response.output_text || '').replace(/^```json\s*|\s*```$/g, ''))
    const analysis = {
      date, source: 'AI 基于已入库数据生成', overview: String(parsed.overview || '暂无概览'),
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.slice(0, 3).map(String) : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks.slice(0, 3).map(String) : [],
      watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist.slice(0, 3).map(String) : []
    }
    dailyCache.set(date, analysis)
    res.json({ analysis, cached: false })
  } catch (error) {
    console.error(error.message)
    res.status(500).json({ error: 'AI 分析暂不可用，请检查服务配置。' })
  }
})

app.listen(Number(process.env.PORT || 80), () => console.log('AI service started'))
