require('dotenv').config();
const cron = require('node-cron');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const SLEEPER_BASE = 'https://api.sleeper.app/v1';
const SLEEPER_USERNAME = 'jaredhagadorn';
const EMAIL_TO = 'jaredahagadorn@gmail.com';
const MODEL = 'gemini-2.5-flash';
const MAX_LEAGUES = 3;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

cron.schedule('0 8 * * 6', () => {
  console.log('[cron] Saturday 8am fired');
  sendWeeklyReport();
});

console.log('Scheduler running. Fires every Saturday at 8am.');

async function sendWeeklyReport() {
  try {
    const dateStr = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    const year = new Date().getMonth() >= 8 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    const user = await sleeperGet('/user/' + SLEEPER_USERNAME);
    if (!user?.user_id) throw new Error('User not found');
    let leagues = await sleeperGet('/user/' + user.user_id + '/leagues/nfl/' + year) || [];
    if (!leagues.length) leagues = await sleeperGet('/user/' + user.user_id + '/leagues/nfl/' + (year-1)) || [];
    if (!leagues.length) throw new Error('No leagues found');
    console.log('Found ' + leagues.length + ' leagues');
    const allPlayers = await sleeperGet('/players/nfl') || {};
    const sections = [];
    for (let i = 0; i < Math.min(leagues.length, MAX_LEAGUES); i++) {
      try {
        const s = await buildLeagueSection(leagues[i], user, allPlayers);
        if (s) sections.push(s);
      } catch(e) { console.error('League error:', e.message); }
      if (i < leagues.length - 1) await sleep(2000);
    }
    const html = buildEmailHtml(dateStr, sections);
    const transporter = nodemailer.createTransport({ service:'gmail', auth:{ user:process.env.GMAIL_USER, pass:process.env.GMAIL_APP_PASSWORD }});
    await transporter.sendMail({ from: '"Fantasy Report" <' + process.env.GMAIL_USER + '>', to: EMAIL_TO, subject: 'Fantasy Report - ' + dateStr, html });
    console.log('Email sent to ' + EMAIL_TO);
  } catch(e) { console.error('Fatal:', e.message); }
}

async function buildLeagueSection(league, user, allPlayers) {
  const [rosters, leagueUsers, tradedPicks] = await Promise.all([
    sleeperGet('/league/' + league.league_id + '/rosters'),
    sleeperGet('/league/' + league.league_id + '/users'),
    sleeperGet('/league/' + league.league_id + '/traded_picks'),
  ]);
  const myRoster = (rosters||[]).find(r => r.owner_id === user.user_id);
  if (!myRoster) return null;
  const myPicks = (tradedPicks||[]).filter(p => p.owner_id === user.user_id);
  const myPlayers = (myRoster.players||[]).map(id => playerInfo(id, allPlayers)).filter(p => p.name !== id);
  const lType = leagueType(league);
  const rankedTeams = (rosters||[]).map(r => {
    const owner = (leagueUsers||[]).find(u => u.user_id === r.owner_id);
    const name = owner?.metadata?.team_name || owner?.display_name || 'Team ' + r.roster_id;
    const players = (r.players||[]).map(id => playerInfo(id, allPlayers)).filter(p => ['QB','RB','WR','TE'].includes(p.pos));
    return { name, isMe: r.owner_id === user.user_id, wins: r.settings?.wins||0, losses: r.settings?.losses||0, score: dynastyScore(r.players||[], allPlayers), topPlayers: players.slice(0,6) };
  }).sort((a,b) => b.score - a.score);
  console.log('  Running AI analysis for ' + league.name);
  const analysis = await callGemini(
    'Expert dynasty fantasy football analyst.\nLeague: ' + league.name + ' (' + lType + ', ' + league.total_rosters + ' teams)\nRoster:\n' +
    myPlayers.map(p => p.name + ' | ' + p.pos + ' | Age:' + (p.age||'?') + ' | ' + p.team).join('\n') +
    '\nFuture picks: ' + (myPicks.length ? myPicks.map(p => p.season + ' R' + p.round).join(', ') : 'None') +
    '\nProvide: 1.GRADE 2.STRENGTHS 3.WEAKNESSES 4.TOP 3 MOVES 5.PICK STRATEGY', false);
  await sleep(1000);
  const comparison = await callGemini(
    'Dynasty analyst. My team marked *.\n' +
    rankedTeams.map((t,i) => (i+1) + '. ' + (t.isMe?'*MY TEAM* ':'') + t.name + ' | ' + t.wins + '-' + t.losses + ' | ' + t.topPlayers.map(p=>p.name+'('+p.pos+')').join(', ')).join('\n') +
    '\nAnalyze: 1.MY RANK 2.TOP 2 THREATS 3.BEST TRADE PARTNERS 4.COMPETITIVE WINDOW', false);
  await sleep(1000);
  const topNames = myPlayers.filter(p => ['QB','RB','WR','TE'].includes(p.pos)).slice(0,12).map(p=>p.name);
  const playerNews = await callGemini('Search for latest fantasy football news and injury updates this week for: ' + topNames.join(', ') + '. Give 1-2 sentence update per player. Bold their name. Skip players with no news.', true);
  return { league, lType, myPlayers, myPicks, rankedTeams, analysis, comparison, playerNews };
}

async function callGemini(prompt, useSearch) {
  try {
    const model = genAI.getGenerativeModel({ model: MODEL, ...(useSearch ? { tools:[{ googleSearch:{} }] } : {}) });
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch(e) { return 'Analysis unavailable: ' + e.message; }
}

function buildEmailHtml(dateStr, sections) {
  const fmt = s => (s||'').replace(/\n/g,'<br>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\*(.*?)\*/g,'<em>$1</em>');
  const posTag = pos => ({QB:'#e6f1fb;color:#185fa5',RB:'#eaf3de;color:#3b6d11',WR:'#e1f5ee;color:#0f6e56',TE:'#faeeda;color:#854f0b'})[pos]||'#f1efe8;color:#5f5e5a';
  let html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:20px}.wrap{max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden}.hdr{background:#1a1a1a;padding:28px 32px}.hdr h1{color:#fff;margin:0;font-size:22px}.hdr p{color:#999;margin:6px 0 0;font-size:13px}.body{padding:28px 32px}.st{font-size:11px;font-weight:600;color:#888;letter-spacing:.07em;text-transform:uppercase;margin:24px 0 10px;border-top:1px solid #f0f0f0;padding-top:20px}.ai{background:#f9f9f9;border-radius:10px;padding:16px;font-size:13px;line-height:1.75}.tag{font-size:11px;padding:3px 9px;border-radius:6px;display:inline-block;margin:2px}.row{display:flex;align-items:center;padding:8px 12px;border-radius:8px;margin-bottom:5px;font-size:13px}</style></head><body><div class="wrap"><div class="hdr"><h1>Fantasy Football Weekly Report</h1><p>' + dateStr + ' · Gemini 2.5 Flash + Sleeper</p></div><div class="body">';
  sections.forEach((sec, idx) => {
    if (idx > 0) html += '<hr style="border:none;border-top:1px solid #f0f0f0;margin:28px 0">';
    const byPos = {};
    sec.myPlayers.forEach(p => { if(!byPos[p.pos]) byPos[p.pos]=[]; byPos[p.pos].push(p); });
    const myRank = sec.rankedTeams.findIndex(t=>t.isMe)+1;
    html += '<h2 style="margin:0 0 4px;font-size:18px">' + sec.league.name + '</h2><p style="color:#888;font-size:12px;margin:0 0 20px">' + sec.lType + ' · ' + sec.league.total_rosters + ' teams · ' + sec.league.season + '</p>';
    html += '<div style="display:flex;gap:12px;margin-bottom:24px">' + [{l:'Players',v:sec.myPlayers.length},{l:'League Rank',v:'#'+myRank},{l:'Future Picks',v:sec.myPicks.length}].map(x=>'<div style="background:#f9f9f9;border-radius:8px;padding:12px;flex:1;text-align:center"><div style="font-size:22px;font-weight:600">' + x.v + '</div><div style="font-size:11px;color:#888">' + x.l + '</div></div>').join('') + '</div>';
    html += '<div class="st">Roster</div>';
    ['QB','RB','WR','TE','K','DEF'].filter(pos=>byPos[pos]).forEach(pos => {
      html += '<div style="margin-bottom:10px"><span style="font-size:11px;color:#aaa;font-weight:600;display:block;margin-bottom:4px">' + pos + '</span>';
      byPos[pos].forEach(p => { html += '<span class="tag" style="background:' + posTag(pos) + '">' + p.name + (p.team&&p.team!='FA'?' · '+p.team:'') + (p.age?' · '+p.age:'') + '</span>'; });
      html += '</div>';
    });
    if (sec.myPicks.length) { html += '<div style="margin-bottom:10px"><span style="font-size:11px;color:#aaa;font-weight:600;display:block;margin-bottom:4px">FUTURE PICKS</span>' + sec.myPicks.map(p=>'<span class="tag" style="background:#eaf3de;color:#3b6d11">' + p.season + ' R' + p.round + '</span>').join('') + '</div>'; }
    html += '<div class="st">AI Roster Analysis</div><div class="ai">' + fmt(sec.analysis) + '</div>';
    html += '<div class="st">League Standings</div>';
    sec.rankedTeams.forEach((t,i) => { html += '<div class="row" style="background:' + (t.isMe?'#e6f1fb':'#f9f9f9') + ';' + (t.isMe?'font-weight:500':'') + '"><span style="width:24px;color:#888;font-weight:600">' + (i+1) + '</span><span style="flex:1">' + t.name + (t.isMe?' ← You':'') + '</span><span style="color:#888;font-size:12px;margin-right:10px">' + t.wins + 'W–' + t.losses + 'L</span><span style="font-weight:600">' + t.score + '</span></div>'; });
    html += '<div class="st">League Analysis</div><div class="ai">' + fmt(sec.comparison) + '</div>';
    html += '<div class="st">Player News</div><div class="ai">' + fmt(sec.playerNews) + '</div>';
  });
  html += '</div><div style="background:#f9f9f9;padding:16px 32px;font-size:11px;color:#aaa;text-align:center;border-top:1px solid #f0f0f0">Sent every Saturday at 8am · Sleeper + Gemini 2.5 Flash</div></div></body></html>';
  return html;
}

async function sleeperGet(path) {
  try { const r = await axios.get(SLEEPER_BASE + path, {timeout:30000}); return r.data; }
  catch(e) { console.error('Sleeper error:', path, e.message); return null; }
}
function playerInfo(id, allPlayers) {
  const p = allPlayers[id];
  if (!p) return {id, name:id, pos:'?', team:'FA', age:null};
  return {id, name:(p.first_name||'') + ' ' + (p.last_name||''), pos:p.position||'?', team:p.team||'FA', age:p.age||null};
}
function dynastyScore(ids, allPlayers) {
  let s=0; ids.forEach(id => { const p=allPlayers[id]; if(!p||!['QB','RB','WR','TE'].includes(p.position)) return; s += p.age<=23?4:p.age<=25?3:p.age<=28?2:1; }); return Math.min(99,s);
}
function leagueType(l) { return l.settings?.type===2?'Dynasty':l.settings?.type===1?'Keeper':'Redraft'; }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }
module.exports = { sendWeeklyReport };
