const slides=[{"num": "01", "title": "Inteligência Esportiva", "headline": "Um departamento de inteligência acessível para o seu clube", "text": "A comissão técnica não precisa de mais dados, precisa de respostas para apoiar suas decisões estratégicas."}, {"num": "02", "title": "Respostas para o campo", "headline": "Respostas práticas para o dia a dia", "text": "Identifique sinais de fadiga, capacidade de carga, disponibilidade e tendências do elenco."}, {"num": "03", "title": "Visão 360°", "headline": "Todos os setores em uma única leitura", "text": "Prontidão, Recuperação, Carga, DM e Planejamento integrados para toda a comissão."}, {"num": "04", "title": "IA Analista", "headline": "Pergunte ao seu banco e receba respostas", "text": "A IA interpreta contexto, tendências e riscos usando a base histórica do próprio clube."}, {"num": "05", "title": "Planejamento", "headline": "Microciclos mais claros e execução mais precisa", "text": "Organize os dias de jogo, os grupos e os objetivos de campo e físico."}, {"num": "06", "title": "Scout", "headline": "Do jogo para a decisão", "text": "Transforme minutos, setores, substituições e ações competitivas em feedback técnico."}, {"num": "07", "title": "Vantagem competitiva", "headline": "O diferencial é a inteligência", "text": "A tecnologia organiza. A inteligência interpreta. A comissão decide."}];
let current=0;
const title=document.getElementById('slideTitle');
const headline=document.getElementById('slideHeadline');
const text=document.getElementById('slideText');
const cards=document.getElementById('slideCards');

function render(){
  const slide=slides[current];
  title.textContent=slide.title;
  headline.textContent=slide.headline;
  text.textContent=slide.text;
  cards.innerHTML=slides.map((item,index)=>`
    <button class="slide-card ${index===current?'active':''}" data-index="${index}">
      <span>${item.num}</span>
      <strong>${item.title}</strong>
    </button>
  `).join('');
  cards.querySelectorAll('.slide-card').forEach(card=>{
    card.addEventListener('click',()=>show(Number(card.dataset.index)));
  });
}

function show(index){
  current=(index+slides.length)%slides.length;
  render();
}

document.querySelector('.prev').addEventListener('click',()=>show(current-1));
document.querySelector('.next').addEventListener('click',()=>show(current+1));
document.addEventListener('keydown',event=>{
  if(event.key==='ArrowLeft') show(current-1);
  if(event.key==='ArrowRight') show(current+1);
});
render();
