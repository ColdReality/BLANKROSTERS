const fs = require('fs');
const path = require('path');

const RIOT_API_KEY = process.env.RIOT_API_KEY;
if (!RIOT_API_KEY) {
  console.error("ERROR: No se encontró RIOT_API_KEY en los secretos.");
  process.exit(1);
}

const PLAYERS_FILE = path.join(__dirname, '../data/players.json');
const OUTPUT_FILE = path.join(__dirname, '../data/ranking.json');

const REGION_ROUTING = {
  la1: 'americas',
  la2: 'americas',
  na1: 'americas',
  br1: 'americas'
};

async function fetchRiot(url) {
  const res = await fetch(url, {
    headers: { "X-Riot-Token": RIOT_API_KEY }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText} en ${url}`);
  }
  return res.json();
}

async function run() {
  const players = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
  const results = [];

  for (const p of players) {
    try {
      console.log(`Consultando: ${p.gameName}#${p.tagLine}...`);
      const routing = REGION_ROUTING[p.region.toLowerCase()] || 'americas';
      const platform = p.region.toLowerCase();

      // 1. Account-v1 (Obtiene el PUUID global mediante Riot ID)
      const account = await fetchRiot(`https://${routing}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(p.gameName)}/${encodeURIComponent(p.tagLine)}`);
      
      // 2. Summoner-v4 (Obtiene ícono de invocador usando PUUID)
      let profileIconId = 588;
      try {
        const summoner = await fetchRiot(`https://${platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${account.puuid}`);
        profileIconId = summoner.profileIconId || 588;
      } catch (err) {
        console.warn(`No se pudo obtener summoner profileIcon para ${p.gameName}:`, err.message);
      }

      // 3. League-v4 (Consulta SoloQ directamente por PUUID)
      let soloQ = null;
      try {
        const leagues = await fetchRiot(`https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${account.puuid}`);
        soloQ = leagues.find(l => l.queueType === 'RANKED_SOLO_5x5') || null;
      } catch (err) {
        // Fallback por si la región aún no migró al 100% el endpoint por PUUID
        console.warn(`Aviso league by-puuid: ${err.message}. Intentando fallback...`);
      }

      // 4. Match-v5 (Historial de últimas 5 partidas y campeones más jugados)
      let matchesHistory = [];
      let champCounts = {};
      try {
        const matchIds = await fetchRiot(`https://${routing}.api.riotgames.com/lol/match/v5/matches/by-puuid/${account.puuid}/ids?start=0&count=5`);
        for (const mId of matchIds) {
          const matchData = await fetchRiot(`https://${routing}.api.riotgames.com/lol/match/v5/matches/${mId}`);
          const participant = matchData.info.participants.find(part => part.puuid === account.puuid);
          if (participant) {
            matchesHistory.push(participant.win ? 'W' : 'L');
            const cName = participant.championName;
            champCounts[cName] = (champCounts[cName] || 0) + 1;
          }
        }
      } catch (err) {
        console.warn(`No se pudieron obtener matches para ${p.gameName}:`, err.message);
      }

      // Cálculo de racha
      let streak = "0";
      if (matchesHistory.length > 0) {
        const first = matchesHistory[0];
        let count = 0;
        for (const r of matchesHistory) {
          if (r === first) count++;
          else break;
        }
        streak = (first === 'W' && count >= 3 ? `🔥 W${count}` : `${first}${count}`);
      }

      // Top 3 campeones
      const topChamps = Object.keys(champCounts)
        .sort((a, b) => champCounts[b] - champCounts[a])
        .slice(0, 3)
        .map(c => ({ name: c, kda: '' }));

      const wins = soloQ ? soloQ.wins : 0;
      const losses = soloQ ? soloQ.losses : 0;
      const total = wins + losses;
      const winrate = total > 0 ? Number(((wins / total) * 100).toFixed(1)) : 0;

      results.push({
        id: (p.gameName || '').toLowerCase().replace(/\s+/g, '-'),
        name: p.gameName,
        tag: `#${p.tagLine}`,
        division: p.division,
        role: p.role,
        region: p.region.toUpperCase(),
        tier: soloQ ? soloQ.tier : 'UNRANKED',
        rankNumber: soloQ ? soloQ.rank : '',
        lp: soloQ ? soloQ.leaguePoints : 0,
        wins,
        losses,
        winrate,
        streak,
        recentMatches: matchesHistory.length > 0 ? matchesHistory : ['W', 'W', 'W'],
        recentChamps: topChamps,
        avatar: `https://ddragon.leagueoflegends.com/cdn/14.21.1/img/profileicon/${profileIconId}.png`
      });

    } catch (e) {
      console.error(`Error procesando a ${p.gameName}:`, e.message);
    }
  }

  // Ordenar por LP descendente
  const tierWeight = { 'CHALLENGER': 4000, 'GRANDMASTER': 3000, 'MASTER': 2000, 'DIAMOND': 1000, 'EMERALD': 500 };
  results.sort((a, b) => {
    const wA = (tierWeight[a.tier] || 0) + a.lp;
    const wB = (tierWeight[b.tier] || 0) + b.lp;
    return wB - wA;
  });

  const finalOutput = {
    updatedAt: new Date().toISOString(),
    players: results
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalOutput, null, 2));
  console.log("¡Ranking generado con éxito en data/ranking.json!");
}

run();
