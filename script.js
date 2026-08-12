/* ------------------------------ */
/* TESTO — ogni riga di HUMAN corrisponde alla stessa riga di MACHINE */
/* "" = riga vuota (spaziatura) */
/* ------------------------------ */

const humanLines = [
    "Reading is one of those things we rarely stop",
    "to question.", "We simply do it. We read books, signs,",
    "interfaces, instructions, messages.",
    "",
    "We read so often that reading itself", "almost disappears.",
    "It becomes invisible.",
    "",
    "Nowadays, computational systems read", "enormous amounts of text.",
    "They classify it, extract it, transform it", "and generate new content from it.", "We rely on these processes constantly, yet we",
    "rarely stop to question what reading actually means for a machine, or how different that", "process is from our own.",
    "",
    "Reading Machines is an attempt to slow that", "process down.",
    "To look at machine reading not as a hidden", "technical operation, but as something that can be observed, questioned and, ultimately,", "designed with.",
];

// Machine column now reads the exact same words as the human column —
// the difference is no longer in the text itself, but in how the machine
// looks at it (bounding boxes, baseline grid, reading order, confidence),
// layered on top via the STATE system below.
const machineLines = humanLines;

/* ------------------------------ */
/* HELPERS */
/* ------------------------------ */

/* same seeded random used in tool-space.html — deterministic per letter, */
/* so its scattered position doesn't jump around as it re-renders/resizes. */

function seededRandom(seed){
    let s = Math.sin(seed) * 10000;
    return s - Math.floor(s);
}

let letterCounter = 0; // shared across both columns, so seeds never repeat

function wrapWordLetters(wordSpan, word){
    word.split("").forEach(ch=>{
        const letter = document.createElement("span");
        letter.className = "letter";
        letter.textContent = ch;

        const seed = letterCounter++;
        const dx  = (seededRandom(seed)       - 0.5) * 220;
        const dy  = (seededRandom(seed+0.33)  - 0.5) * 220;
        const rot = (seededRandom(seed+0.66)  - 0.5) * 200;

        letter.dataset.dx  = dx.toFixed(1);
        letter.dataset.dy  = dy.toFixed(1);
        letter.dataset.rot = rot.toFixed(1);

        wordSpan.appendChild(letter);
    });
}

function computeConfidence(word, isMachine){
    const clean = word.replace(/[^a-zA-Z0-9]/g,"");
    const len = clean.length || 1;
    const upper = (clean.match(/[A-Z]/g)||[]).length;
    const upperRatio = upper/len;
    const symbolRatio = (word.length-clean.length)/word.length;

    let conf = 95 - (symbolRatio*40) - (upperRatio*30) - (len<3?15:0);
    if(isMachine) conf -= 10;

    return Math.max(8, Math.min(99, Math.round(conf)));
}

function renderLines(contentEl, lines, isMachine){

    let idx = 0;

    lines.forEach((line, lineIdx)=>{

        const p = document.createElement("p");

        if(line === ""){
            p.innerHTML = "&nbsp;";
        } else {
            const words = line.split(/\s+/);
            words.forEach((w, i)=>{
                const conf = computeConfidence(w, isMachine);
                const span = document.createElement("span");
                span.className = "word";
                span.dataset.idx = idx++;
                span.dataset.line = lineIdx;
                span.dataset.conf = conf;
                span.style.setProperty("--conf", conf);
                wrapWordLetters(span, w);
                p.appendChild(span);
                if(i < words.length - 1){
                    p.appendChild(document.createTextNode(" "));
                }
            });
        }

        contentEl.appendChild(p);

    });

}

/* ------------------------------ */
/* ELEMENTS */
/* ------------------------------ */

const human = document.querySelector("#human");
const machine = document.querySelector("#machine");
const humanContent = human.querySelector(".content");
const machineContent = machine.querySelector(".content");

renderLines(humanContent, humanLines, false);
renderLines(machineContent, machineLines, true);

/* ------------------------------ */
/* UI — toggle sottili per colonna */
/* ------------------------------ */

const humanToggle = document.createElement("button");
humanToggle.className = "col-toggle on toggle-left";
document.body.appendChild(humanToggle);

const machineToggle = document.createElement("button");
machineToggle.className = "col-toggle on toggle-right";
document.body.appendChild(machineToggle);

const state = document.createElement("div");
state.className = "state";
state.innerHTML = "STATE 01";
state.style.cursor = "pointer";
document.body.appendChild(state);

let humanOn = true;
let machineOn = true;

function updateView(){

    document.body.classList.remove("show-both","show-human","show-machine");

    if(humanOn && machineOn){
        document.body.classList.add("show-both");
    } else if(humanOn){
        document.body.classList.add("show-human");
    } else if(machineOn){
        document.body.classList.add("show-machine");
    }

}

humanToggle.onclick = ()=>{
    if(humanOn && !machineOn) return; // non spegnere l'ultima colonna attiva
    humanOn = !humanOn;
    humanToggle.classList.toggle("on", humanOn);
    updateView();
};

machineToggle.onclick = ()=>{
    if(machineOn && !humanOn) return;
    machineOn = !machineOn;
    machineToggle.classList.toggle("on", machineOn);
    updateView();
};

document.body.classList.add("show-both","state-1");

/* ------------------------------ */
/* SCROLL — the marquee now auto-plays on its own timer only; real page  */
/* scroll (mouse wheel / trackpad / spacebar) is no longer intercepted,   */
/* so it does what it does everywhere else on the site: moves you down    */
/* off the landing and into the tool pages appended below. The marquee's  */
/* own drift, state-cycling and letter dissolve effect keep running        */
/* regardless of where you've scrolled to.                                 */
/* ------------------------------ */

let humanY = 0;
let machineY = 0;

const scrollSpeed = 40; // px al secondo — stessa per entrambe le colonne

let contentHeight = 0;
let viewportHeight = 0;

function measureHeights(){
    contentHeight = humanContent.offsetHeight || 1;
    viewportHeight = human.parentElement.offsetHeight || 0;
}

measureHeights();
window.addEventListener("load", measureHeights);
if(document.fonts && document.fonts.ready) document.fonts.ready.then(measureHeights);

let resizeTimer;
window.addEventListener("resize", ()=>{
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(measureHeights, 200);
});

/* ------------------------------ */

let currentState = 1;
const totalStates = 6;

state.onclick = ()=> nextState();

function nextState(){
    currentState++;
    if(currentState>totalStates) currentState=1;
    state.innerHTML=`STATE 0${currentState}`;
    document.body.classList.remove("state-1","state-2","state-3","state-4","state-5","state-6");
    document.body.classList.add(`state-${currentState}`);
}

/* ------------------------------ */

let lastTime = performance.now();

/* ------------------------------ */

function wrapScroll(){
    const limit = contentHeight + viewportHeight;

    // can't drift back past the very start
    if(humanY > 0){
        humanY = 0;
        machineY = 0;
    }

    if(Math.abs(humanY) >= limit){
        humanY = 0;
        machineY = 0;
        nextState();
    }
}

/* ------------------------------ */
/* CLICK-THROUGH — clicking either column jumps down to the tool pages,  */
/* which now live further down this same page instead of a separate one. */
/* ------------------------------ */

document.querySelectorAll(".panel").forEach(panel=>{
    panel.addEventListener("click", ()=>{
        const presenter = document.getElementById("presenter");
        if(presenter){ presenter.scrollIntoView({ behavior: "smooth" }); }
    });
});

document.getElementById("enter-link") && document.getElementById("enter-link").addEventListener("click", (e)=>{
    const presenter = document.getElementById("presenter");
    if(presenter){
        e.preventDefault();
        presenter.scrollIntoView({ behavior: "smooth" });
    }
});

/* ------------------------------ */
/* DISPERSION — same focus/scatter idea as tool-space: lines near the    */
/* vertical center of the screen read clean and in place; the further a   */
/* line drifts from that center as it scrolls by, the more its letters      */
/* scatter apart, rotate and fade — reading dissolving as it moves out of  */
/* view, then reassembling as the next line arrives. applies to both        */
/* columns, exactly like tool-space's fragments.                            */
/* ------------------------------ */

function updateTextFocus(){

    const cy = window.innerHeight / 2;
    const plateau   = window.innerHeight * 0.16;
    const fadeRange = window.innerHeight * 0.48;

    document.querySelectorAll(".content p").forEach(p=>{

        const rect = p.getBoundingClientRect();
        const by = rect.top + rect.height/2;
        const dist = Math.abs(by - cy);

        let focus;
        if(dist <= plateau){
            focus = 1;
        } else {
            focus = Math.max(0, 1 - (dist-plateau)/fadeRange);
        }
        const scatter = 1 - focus;

        // STATE 2's bounding boxes read as clutter when they sit on top of
        // clean, in-focus text — so they fade in/out with the same scatter
        // value as the letters themselves: invisible on the readable band,
        // visible only where the line is already coming apart anyway.
        p.style.setProperty("--scatter", scatter.toFixed(3));

        p.querySelectorAll(".letter").forEach(span=>{
            const dx  = parseFloat(span.dataset.dx)  * scatter;
            const dy  = parseFloat(span.dataset.dy)  * scatter;
            const rot = parseFloat(span.dataset.rot) * scatter;

            span.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
            span.style.opacity = 0.15 + focus*0.85;
        });

    });

}

/* ------------------------------ */

function animate(now){

    const dt = (now - lastTime) / 1000;
    lastTime = now;

    const move = scrollSpeed * dt;
    humanY -= move;
    machineY -= move; // stessa velocità → restano sempre allineate
    wrapScroll();

    human.style.transform = `translate3d(0, ${humanY}px, 0)`;
    machine.style.transform = `translate3d(0, ${machineY}px, 0)`;

    updateTextFocus();

    requestAnimationFrame(animate);

}

requestAnimationFrame(animate);
