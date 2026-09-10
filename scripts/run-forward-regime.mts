import { GET } from '../app/api/backtest-forward-regime/route';
const response = await GET();
const text = await response.text();
console.log('=== V28.2 FORWARD REGIME FULL BACKTEST RESULT ===');
console.log(text);
console.log('=== END V28.2 FORWARD REGIME FULL BACKTEST RESULT ===');
