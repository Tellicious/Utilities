(()=>{'use strict';
let mode='non';
const $=id=>document.getElementById(id);
function n(id){return Number(String($(id).value).replace(',','.'))}
function schematic(){
  const el=$('opSchematic'); if(!el)return;
  if(mode==='inv'){
    el.innerHTML=`<svg viewBox="0 0 544 302" fill="none" aria-label="Inverting amplifier schematic">
      <g stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="244,103 244,249 389,176" fill="none"/>

        <line x1="67" y1="164" x2="117" y2="164"/>
        <circle cx="59" cy="164" r="6" fill="var(--surface-2)"/>
        <polyline points="117,164 128,153 139,175 150,153 161,175 172,153 183,175 194,164"/>
        <line x1="194" y1="164" x2="244" y2="164"/>
        <circle cx="219" cy="164" r="6" fill="currentColor" stroke="none"/>

        <path d="M219 164V51H275"/>
        <polyline points="275,51 286,40 297,62 308,40 319,62 330,40 341,62 352,51"/>
        <path d="M352 51H434V176"/>

        <line x1="389" y1="176" x2="464" y2="176"/>
        <circle cx="434" cy="176" r="6" fill="currentColor" stroke="none"/>
        <circle cx="464" cy="176" r="6" fill="var(--surface-2)"/>

        <path d="M244 219H198V253"/>
        <line x1="181" y1="253" x2="215" y2="253"/>
        <line x1="187" y1="264" x2="209" y2="264"/>
        <line x1="193" y1="275" x2="203" y2="275"/>
      </g>
      <g fill="currentColor" style="font:600 30px var(--font-sans);">
        <text x="17" y="172">V<tspan x="36" y="180" font-size="16">in</tspan></text>
        <text x="143" y="113">R<tspan x="164" y="121" font-size="16">in</tspan></text>
        <text x="297" y="31">R<tspan x="318" y="39" font-size="16">f</tspan></text>
        <text x="476" y="184">V<tspan x="495" y="192" font-size="16">out</tspan></text>
        <text x="255" y="159" style="font-size:38px;">−</text>
        <text x="256" y="228" style="font-size:38px;">+</text>
      </g>
    </svg>`;
  } else {
    el.innerHTML=`<svg viewBox="-42.5 0 544 428" fill="none" aria-label="Non-inverting amplifier schematic">
      <g stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="136,20 136,177 292,98" fill="none"/>

        <line x1="82" y1="52" x2="136" y2="52"/>
        <circle cx="75" cy="52" r="6" fill="var(--surface-2)"/>

        <line x1="292" y1="98" x2="383" y2="98"/>
        <circle cx="348" cy="98" r="6" fill="currentColor" stroke="none"/>
        <circle cx="383" cy="98" r="6" fill="var(--surface-2)"/>

        <path d="M136 145H86V241"/>
        <circle cx="86" cy="241" r="6" fill="currentColor" stroke="none"/>
        <line x1="86" y1="241" x2="86" y2="270"/>
        <polyline points="86,270 73,282 99,295 73,308 99,321 73,334 99,347 86,359"/>
        <line x1="86" y1="359" x2="86" y2="384"/>
        <line x1="66" y1="384" x2="106" y2="384"/>
        <line x1="73" y1="397" x2="99" y2="397"/>
        <line x1="80" y1="409" x2="92" y2="409"/>

        <line x1="86" y1="241" x2="166" y2="241"/>
        <polyline points="166,241 178,229 190,253 202,229 214,253 226,229 238,253 250,241"/>
        <path d="M250 241H348V98"/>
      </g>
      <g fill="currentColor" style="font:600 30px var(--font-sans);">
        <text x="23" y="61">V<tspan x="42" y="69" font-size="16">in</tspan></text>
        <text x="36" y="317">R<tspan x="57" y="325" font-size="16">in</tspan></text>
        <text x="196" y="218">R<tspan x="217" y="226" font-size="16">f</tspan></text>
        <text x="393" y="107">V<tspan x="412" y="115" font-size="16">out</tspan></text>
        <text x="146" y="63" style="font-size:38px;">+</text>
        <text x="148" y="150" style="font-size:38px;">−</text>
      </g>
    </svg>`;
  }
}
function set(m){mode=m;$('noninv').classList.toggle('seg__btn--active',m==='non');$('inv').classList.toggle('seg__btn--active',m==='inv');schematic();render()}
function render(){const rin=n('rin'),rf=n('rf'),out=$('opValue'),meta=$('opMeta');if(!(rin>0&&rf>=0)){out.textContent='—';meta.textContent='Enter positive resistor values.';return}const g=mode==='non'?1+rf/rin:-(rf/rin);out.textContent=`${Number(g.toPrecision(5))}×`;meta.textContent=mode==='non'?`Non-inverting: Av = 1 + Rf/Rin`:`Inverting: Av = -Rf/Rin`}
['rin','rf'].forEach(id=>$(id).addEventListener('input',render));$('noninv').onclick=()=>set('non');$('inv').onclick=()=>set('inv');set('non');})();
