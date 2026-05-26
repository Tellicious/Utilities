(()=>{'use strict';
const E24=[10,11,12,13,15,16,18,20,22,24,27,30,33,36,39,43,47,51,56,62,68,75,82,91];
function num(id){return Number(String(document.getElementById(id).value).replace(',','.'))}
function fmt(o){if(o>=1e6)return `${Number((o/1e6).toPrecision(3))} MΩ`;if(o>=1e3)return `${Number((o/1e3).toPrecision(3))} kΩ`;return `${Number(o.toPrecision(3))} Ω`}
function nearest(v){let e=Math.floor(Math.log10(v))-1,n=v/10**e,b=E24[0],d=1e9;for(const x of E24){const dd=Math.abs(Math.log(x)-Math.log(n));if(dd<d){d=dd;b=x}}return b*10**e}
function render(){const vs=num('vs'),vf=num('vf'),ma=num('ma'),c=Math.max(1,Math.floor(num('count')||1)),out=document.getElementById('ledValue'),meta=document.getElementById('ledMeta');const drop=vf*c,i=ma/1000;if(!vs||!vf||!ma||drop>=vs||i<=0){out.textContent='—';meta.textContent='Supply must be greater than total LED forward voltage.';return}const r=(vs-drop)/i, std=nearest(r), p=i*i*std;out.textContent=fmt(std);meta.textContent=`Calculated ${fmt(r)} • ${Number((p*1000).toPrecision(3))} mW, use at least ${p<.125?'1/8 W':p<.25?'1/4 W':p<.5?'1/2 W':'1 W+'}`}
document.querySelectorAll('input').forEach(i=>i.addEventListener('input',render));render();})();
