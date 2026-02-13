<h1>Stremio – Vlastní žebříčky – Home Assistant Add-on</h1>

<p>Stremio addon „Vlastní žebříčky“ pro Home Assistant. Vzniklo to proto, že mě nebavilo pořád dokola koukat na ty stejné nabídky filmů a seriálů z Cinemeta a chtěl jsem mít možnost si to definovat jednoduše sám + pomocí Smart pick seznamů mít každý večer na výběr z jiných nabídek na co koukat</p>

<p>Add-on má dvě části:</p>
<ul>
  <li>Stremio addon server (manifest + katalogy) na portu 7000</li>
  <li>Config UI na portu 7788 (sprava listu, Trakt/TMDB klicu a spusteni aktualizace)</li>
</ul>

<p>Data (konfigurace, vygenerované listy a cache) se ukládají do <code>/data</code>, takže po restartu nebo aktualizaci add-onu nic nezmizí.</p>

<h2>Co to umí</h2>
<ul>
  <li>Servíruje <code>manifest.json</code> a katalogy pro Stremio</li>
  <li>Konfigurační UI pro:
    <ul>
      <li><code>lists.trakt.json</code> (definice listů a SmartPicks profilů)</li>
      <li><code>secrets.json</code> (Trakt client_id / client_secret + volitelne TMDB)</li>
      <li>spuštění update procesu (generování listů + SmartPicks + enrich)</li>
    </ul>
  </li>
  <li>Update je odlehčený:
    <ul>
      <li>listy se nepřepisují, pokud se nezměnily (skip write)</li>
      <li>enrich se pouští jen když se něco změnilo</li>
    </ul>
  </li>
</ul>

<h2>Porty</h2>
<ul>
  <li><strong>7000/tcp</strong> – Stremio addon server<br>
    Manifest: <code>http://HOME_ASSISTANT_IP:7000/manifest.json</code>
  </li>
  <li><strong>7788/tcp</strong> – Config UI<br>
    UI: <code>http://HOME_ASSISTANT_IP:7788/</code>
  </li>
</ul>

<p>Poznámka: v HA UI se u add-onu obvykle ukáže tlačítko „Otevřít web UI“ jen pro jednu URL. Tenhle add-on má dva weby, takže druhý se otevírá ručně přes adresu a port.</p>

<h2>Kde jsou data</h2>
<p>Všechno důležité je v <code>/data</code> (persistuje):</p>
<ul>
  <li><code>/data/config/lists.trakt.json</code></li>
  <li><code>/data/config/secrets.json</code></li>
  <li><code>/data/lists/*.json</code> (výsledné listy pro Stremio)</li>
  <li><code>/data/runtime/*</code> (cache, mezisoubory)</li>
  <li><code>/data/runtime/enrich-cache/*</code> (cache pro enrich)</li>
</ul>

<p>Při prvním startu se může provést migrace z <code>/app/*</code> do <code>/data/*</code> (pokud v image existují starší soubory).</p>

<h2>Jak to použít ve Stremiu</h2>
<ol>
  <li>Otevři Config UI na <code>http://HOME_ASSISTANT_IP:7788/</code></li>
  <li>Vyplň Trakt <code>client_id</code> a <code>client_secret</code>, ulož konfiguraci</li>
  <li>Volitelne pridej TMDB do <code>secrets.json</code> (pro <code>provider: "tmdb"</code> zdroje): <code>tmdb.access_token</code> nebo <code>tmdb.api_key</code></li>
  <li>Spusť update (v UI)</li>
  <li>Ve Stremiu přidej addon přes manifest URL: <code>http://HOME_ASSISTANT_IP:7000/manifest.json</code></li>
</ol>

<h2>Automatická aktualizace listů (doporučeno)</h2>
<p>Add-on sám od sebe nic nespouští „každou noc“. Nejjednodušší je udělat to přes Home Assistant automatizaci a <code>rest_command</code>, který zavolá Config UI endpoint.</p>

<p>Příklad <code>rest_command</code> v <code>configuration.yaml</code>:</p>
<pre><code>rest_command:
  stremio_zebricky_update:
    url: "http://HOME_ASSISTANT_IP:7788/api/run-update"
    method: POST
    content_type: "application/json"
    payload: "{}"
    timeout: 300
</code></pre>

<p>Důležité:</p>
<ul>
  <li>po úpravě <code>configuration.yaml</code> musíš dát „Reload“ (nebo restart HA), aby se <code>rest_command</code> zaregistroval</li>
  <li>pokud používáš token v Config UI, je potřeba ho poslat jako query <code>?token=...</code> nebo v hlavičce <code>x-config-token</code></li>
</ul>

<p>Příklad automatizace (běh každý den ve 3:17):</p>
<pre><code>alias: Stremio – update žebříčků
trigger:
  - platform: time
    at: "03:17:00"
action:
  - service: rest_command.stremio_zebricky_update
mode: single
</code></pre>

<h2>Watchdog v add-onu</h2>
<p>Watchdog v HA add-onech hlídá, jestli proces běží. U tohohle add-onu se většinou hodí mít zapnutý, protože:</p>
<ul>
  <li>addon server i Config UI mají běžet pořád</li>
  <li>když něco spadne, watchdog add-on restartuje</li>
</ul>

<p>Poznámka: watchdog neřeší nedostatek RAM. Pokud hostovi dojde paměť, systém může killnout procesy a restart nemusí pomoct. V takovém případě je řešení přidat RAM nebo snížit zátěž (např. méně kandidátů, delší sleep, méně listů).</p>

<h2>Troubleshooting</h2>

<h3><code>Action rest_command.stremio_zebricky_update not found</code></h3>
<p><code>rest_command</code> se načítá z <code>configuration.yaml</code>. Ověř:</p>
<ul>
  <li>že to je opravdu v <code>configuration.yaml</code> (ne v Automation editoru)</li>
  <li>že YAML je validní (bez špatných indentů)</li>
  <li>že jsi po změně udělal reload/restart</li>
</ul>

<h3>Update spadne uprostřed generování</h3>
<p>Nejčastěji je to:</p>
<ul>
  <li>nedostatek RAM (host pak zabije node proces)</li>
  <li>příliš agresivní nastavení (hodně kandidátů, krátké sleep)</li>
</ul>

<p>Pomůže:</p>
<ul>
  <li>přidat RAM</li>
  <li>snížit <code>candidatePages</code>, <code>pageLimit</code>, <code>finalSize</code></li>
  <li>zvýšit <code>sleepMs</code></li>
</ul>

<h3>Nejde otevřít Config UI</h3>
<p>Zkontroluj:</p>
<ul>
  <li>že je add-on spuštěný</li>
  <li>že máš port 7788 vystavený</li>
  <li>že nepoužíváš token a zároveň ho neposíláš</li>
</ul>

<h2>Licence</h2>
<p>Soukromý projekt pro vlastní použití. Pokud to budeš forknout nebo sdílet, uprav si to podle sebe.</p>
