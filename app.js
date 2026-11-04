const $=id=>document.getElementById(id);
const map=L.map("map").setView([39.1325,-84.5155],16);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
const grp=L.featureGroup().addTo(map);

// Fallback landmarks, used only if the OpenStreetMap building lookup fails
let places=new Map([["Nippert Stadium",[39.1312,-84.5162]],["Langsam Library",[39.1350,-84.5152]],["Tangeman University Center",[39.1331,-84.5152]]]);
const custom={from:null,to:null};let next="from";

function fillList(){
  const dl=$("pl");dl.textContent="";
  [...places.keys()].sort((a,b)=>a.localeCompare(b)).forEach(n=>{const o=document.createElement("option");o.value=n;dl.appendChild(o)});
}
fillList();

// Real campus buildings from OpenStreetMap (Overpass API)
(async()=>{
  const bb="(39.125,-84.525,39.139,-84.503)";
  const q=`[out:json][timeout:25];(nwr["name"]["building"]${bb};nwr["name"]["amenity"~"library|cafe|restaurant|fast_food"]${bb};nwr["name"]["leisure"~"stadium|sports_centre"]${bb};);out center tags;`;
  try{
    const r=await fetch("https://overpass-api.de/api/interpreter",{method:"POST",body:"data="+encodeURIComponent(q)});
    const j=await r.json(),m=new Map();
    j.elements.forEach(e=>{
      const n=e.tags&&e.tags.name,ll=e.type==="node"?[e.lat,e.lon]:(e.center&&[e.center.lat,e.center.lon]);
      if(n&&ll&&!m.has(n))m.set(n,ll);
    });
    if(m.size){places=m;fillList();$("status").textContent=m.size+" places loaded from OpenStreetMap.";}
    else $("status").textContent="No buildings returned; using a short fallback list.";
  }catch(e){$("status").textContent="Couldn’t load the building list; using a short fallback list. You can still drop pins on the map."}
})();

function get(f){
  const v=$(f).value.trim();if(!v)return null;
  if(custom[f]&&custom[f].n===v)return custom[f];
  const lv=v.toLowerCase();
  for(const[n,ll]of places)if(n.toLowerCase()===lv)return{n,ll};
  for(const[n,ll]of places)if(n.toLowerCase().includes(lv))return{n,ll};
  return null;
}
const msg=t=>$("msg").textContent=t||"";
function say(s){
  const m=s.maneuver,mod=m.modifier||"",on=s.name?` onto ${s.name}`:"";
  if(m.type==="depart")return"Start"+(s.name?` on ${s.name}`:"");
  if(m.type==="arrive")return"Arrive at your destination";
  if(m.type==="roundabout"||m.type==="rotary")return"Take the roundabout"+on;
  if(!mod||mod==="straight"||m.type==="continue"||m.type==="new name")return"Continue"+(s.name?` on ${s.name}`:"");
  return(mod.startsWith("slight")?"Bear "+mod.slice(7):"Turn "+mod)+on;
}
function dot(ll,color,label){return L.circleMarker(ll,{radius:8,color:"#fff",weight:2,fillColor:color,fillOpacity:1}).bindTooltip(label)}

async function go(){
  msg("");
  const a=get("from"),b=get("to");
  if(!a||!b)return msg("Choose a start and a destination from the suggestions, or click the map.");
  const url=`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${a.ll[1]},${a.ll[0]};${b.ll[1]},${b.ll[0]}?overview=full&geometries=geojson&steps=true`;
  try{
    const r=await fetch(url),j=await r.json();
    if(j.code!=="Ok")throw new Error(j.code||"no route");
    const rt=j.routes[0];
    grp.clearLayers();
    L.geoJSON(rt.geometry,{style:{color:"#e00122",weight:6,opacity:.9}}).addTo(grp);
    dot(a.ll,"#1a9d4a",a.n).addTo(grp);dot(b.ll,"#e00122",b.n).addTo(grp);
    map.fitBounds(grp.getBounds(),{padding:[40,40]});
    $("sum").textContent=`${Math.round(rt.distance)} m · about ${Math.max(1,Math.round(rt.duration/60))} min walk`;
    const ol=$("steps");ol.textContent="";
    rt.legs[0].steps.filter(s=>s.distance>=3||s.maneuver.type==="arrive").forEach(s=>{
      const li=document.createElement("li");li.textContent=say(s);
      if(s.distance>=3){const sm=document.createElement("small");sm.textContent=` · ${Math.round(s.distance)} m`;li.appendChild(sm)}
      ol.appendChild(li);
    });
  }catch(e){msg(`Couldn’t get a walking route (${e.message}). Try again in a moment.`)}
}
const both=()=>get("from")&&get("to");
$("go").onclick=go;
$("from").onchange=$("to").onchange=()=>{if(both())go()};
$("swap").onclick=()=>{
  const v=$("from").value;$("from").value=$("to").value;$("to").value=v;
  [custom.from,custom.to]=[custom.to,custom.from];if(both())go();
};
map.on("click",e=>{
  const f=next;custom[f]={n:f==="from"?"Start pin":"End pin",ll:[e.latlng.lat,e.latlng.lng]};
  $(f).value=custom[f].n;next=f==="from"?"to":"from";if(both())go();
});
$("loc").onclick=()=>{
  if(!navigator.geolocation)return msg("Location isn’t available in this browser.");
  navigator.geolocation.getCurrentPosition(p=>{
    custom.from={n:"My location",ll:[p.coords.latitude,p.coords.longitude]};
    $("from").value="My location";next="to";if(both())go();
  },()=>msg("Couldn’t get your location (permission denied?)."));
};
