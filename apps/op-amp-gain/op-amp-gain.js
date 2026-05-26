(()=>{'use strict';let mode='non';const $=id=>document.getElementById(id);function n(id){return Number(String($(id).value).replace(',','.'))}function schematic(){
  const el=$('opSchematic');
  if(!el)return;
  if(mode==='inv'){
    el.innerHTML=`<svg viewBox="0 0 360 170" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <!-- op-amp -->
        <path d="M165 45 L165 125 L250 85 Z" fill="none"/>
        <line x1="250" y1="85" x2="318" y2="85"/>

        <!-- inverting input: Vin -> Rin -> summing node -> minus input -->
        <line x1="28" y1="65" x2="70" y2="65"/>
        <polyline points="70,65 78,55 86,75 94,55 102,75 110,55 118,75 126,65" fill="none"/>
        <line x1="126" y1="65" x2="165" y2="65"/>
        <circle cx="140" cy="65" r="2.4" fill="currentColor" stroke="none"/>

        <!-- feedback resistor from output back to summing node -->
        <path d="M140 65 V25 H190"/>
        <polyline points="190,25 198,15 206,35 214,15 222,35 230,15 238,35 246,25" fill="none"/>
        <path d="M246 25 H250 V85"/>

        <!-- non-inverting input grounded -->
        <line x1="165" y1="105" x2="132" y2="105"/>
        <line x1="132" y1="105" x2="132" y2="130"/>
        <line x1="120" y1="130" x2="144" y2="130"/>
        <line x1="124" y1="138" x2="140" y2="138"/>
        <line x1="128" y1="146" x2="136" y2="146"/>
      </g>
      <g fill="currentColor" font-family="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" font-size="14" font-weight="650">
        <text x="8" y="70">Vin</text>
        <text x="321" y="90">Vout</text>
        <text x="88" y="52">Rin</text>
        <text x="214" y="52">Rf</text>
        <text x="151" y="69">−</text>
        <text x="151" y="109">+</text>
      </g>
    </svg>`;
  }else{
    el.innerHTML=`<svg viewBox="0 0 360 170" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <!-- op-amp -->
        <path d="M165 45 L165 125 L250 85 Z" fill="none"/>
        <line x1="250" y1="85" x2="318" y2="85"/>

        <!-- Vin directly to non-inverting input -->
        <line x1="28" y1="105" x2="165" y2="105"/>

        <!-- inverting feedback node -->
        <line x1="165" y1="65" x2="135" y2="65"/>
        <circle cx="135" cy="65" r="2.4" fill="currentColor" stroke="none"/>

        <!-- Rf from output to inverting node -->
        <path d="M135 65 V25 H190"/>
        <polyline points="190,25 198,15 206,35 214,15 222,35 230,15 238,35 246,25" fill="none"/>
        <path d="M246 25 H250 V85"/>

        <!-- Rin from inverting node to ground -->
        <line x1="135" y1="65" x2="135" y2="88"/>
        <polyline points="135,88 125,96 145,104 125,112 145,120 135,128" fill="none"/>
        <line x1="135" y1="128" x2="135" y2="140"/>
        <line x1="123" y1="140" x2="147" y2="140"/>
        <line x1="127" y1="148" x2="143" y2="148"/>
        <line x1="131" y1="156" x2="139" y2="156"/>
      </g>
      <g fill="currentColor" font-family="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" font-size="14" font-weight="650">
        <text x="8" y="110">Vin</text>
        <text x="321" y="90">Vout</text>
        <text x="214" y="52">Rf</text>
        <text x="146" y="113">Rin</text>
        <text x="151" y="69">−</text>
        <text x="151" y="109">+</text>
      </g>
    </svg>`;
  }
}
function set(m){mode=m;$('noninv').classList.toggle('seg__btn--active',m==='non');$('inv').classList.toggle('seg__btn--active',m==='inv');schematic();render()}function render(){const rin=n('rin'),rf=n('rf'),out=$('opValue'),meta=$('opMeta');if(!(rin>0&&rf>=0)){out.textContent='—';meta.textContent='Enter positive resistor values.';return}const g=mode==='non'?1+rf/rin:-(rf/rin);out.textContent=`${Number(g.toPrecision(5))}×`;meta.textContent=mode==='non'?`Non-inverting: Av = 1 + Rf/Rin`:`Inverting: Av = -Rf/Rin`}['rin','rf'].forEach(id=>$(id).addEventListener('input',render));$('noninv').onclick=()=>set('non');$('inv').onclick=()=>set('inv');set('non');})();