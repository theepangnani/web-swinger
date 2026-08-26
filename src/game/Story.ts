import type { VillainKind } from '../enemies/EnemySystem';
import type { CrimeKind } from '../enemies/ThugSystem';
import type { HeroId } from './Heroes';

/**
 * The narrative layer: who says what, and when.
 *
 * The campaign in `GameMode` is structure — how many crimes, which boss, what
 * time of day. This file is the part that makes the structure mean something.
 * A chapter that says "clear three crimes and then fight Electro" is a task
 * list; the same chapter with Watanabe on the radio, Mary Jane chasing the
 * paperwork and Dillon explaining why he stopped waiting for anyone to help is
 * a story. Nothing here changes what the player has to do — it changes what
 * the player is told while they do it.
 *
 * Three things live here:
 *
 *  - **Chapter beats.** An opening exchange, a line partway through the street
 *    work, and a closing exchange, plus a line for each boss arriving and each
 *    boss going down. Keyed by chapter *title*, which is why `tests/story.mjs`
 *    asserts those titles are unique.
 *  - **The radio.** Jameson ranting, Watanabe calling crimes in, May, MJ,
 *    Ganke, Rio and Danika. Gated by how far through the books you are, so the
 *    city's chatter changes as the story does.
 *  - **The director.** A small queue that paces lines out through the existing
 *    subtitle and voice pipeline rather than dumping a whole scene at once.
 *
 * Dialogue avoids contractions throughout. That is not an affectation — it
 * matches the bark banks in `Voice.ts`, and every line here can be handed to a
 * speech synthesiser, which reads "do not" far more reliably than "don't".
 */

/** Everyone with a voice. Villains speak under their own `VillainKind`. */
export type StorySpeaker =
  | 'PETER'
  | 'MILES'
  | 'MJ'
  | 'MAY'
  | 'YURI'
  | 'JAMESON'
  | 'GANKE'
  | 'RIO'
  | 'DANIKA'
  | VillainKind;

/**
 * Who a line is authored against.
 *
 * Most chapters can be played as either hero, so a line the player character
 * should say is authored as `HERO` and resolved at delivery. `PARTNER` is the
 * other Spider-Man — only meaningful in the chapters that field one, which is
 * why `tests/story.mjs` checks that no `PARTNER` line appears in a chapter
 * without `ally: true`.
 */
export type LineSpeaker = StorySpeaker | 'HERO' | 'PARTNER';

/** Authored form: a speaker and a line. Terse on purpose — there are hundreds. */
export type Script = readonly (readonly [LineSpeaker, string])[];

/**
 * A non-spoken interstitial: the chapter title card, and the notice that a
 * chapter has taken the hero choice away from you.
 *
 * It goes through the same queue as dialogue rather than being written
 * straight to the HUD, because it has to land *between* a chapter closing and
 * the next one opening. Shown directly it would appear the instant the chapter
 * advanced and be painted over by the closing exchange one frame later, which
 * is how the player ends up not knowing which chapter they are on.
 */
export interface StoryCard {
  /** "BOOK TWO · CH 1/5" */
  readonly label: string;
  readonly title: string;
  /** How long it holds the screen, so the HUD can match the director. */
  readonly seconds: number;
}

/** Delivered form, after `HERO` and `PARTNER` are resolved to a real speaker. */
export interface StoryLine {
  readonly speaker: StorySpeaker;
  readonly text: string;
  /**
   * Index of this line within the speaker's story bank, so a recorded clip
   * pack can be indexed exactly the way barks are.
   */
  readonly clip: number;
  /**
   * How long the director holds the floor for this line.
   *
   * Published rather than kept private because the subtitle has to last
   * exactly as long: on the HUD's fixed bark window a six-second line lost its
   * text halfway through being read aloud.
   */
  readonly seconds: number;
}

export interface ChapterBeats {
  /** Plays when the chapter starts. */
  readonly open?: Script;
  /** Plays halfway through the chapter's street work. Skipped if it has none. */
  readonly mid?: Script;
  /** Plays when the chapter is completed, before the next one opens. */
  readonly close?: Script;
  /** Plays when a villain the chapter named is brought into play. */
  readonly meet?: Partial<Record<VillainKind, Script>>;
  /**
   * Plays the first time that villain drops below half health, overriding the
   * generic `TURN` bank. Written only for the fights where the turn means
   * something specific — everywhere else the generic line is the better one,
   * because it is the villain talking rather than the plot.
   */
  readonly turn?: Partial<Record<VillainKind, Script>>;
  /**
   * Two villains on the same roof talking to each other, once, shortly after
   * both are in play. Only meaningful in a team-up.
   */
  readonly banter?: Script;
  /** Plays when one of them goes down. */
  readonly down?: Partial<Record<VillainKind, Script>>;
}

// ---------------------------------------------------------------- chapters

/**
 * Beats for every chapter, keyed by title.
 *
 * The arc underneath: Osborn is the hand behind all six villains, and each
 * book turns over another piece of him. Black Cat is on his payroll and leaks
 * him anyway. Dillon was hurt on a contract nobody will admit exists. The
 * symbiote came out of an incident report one line long. Marko is a father
 * being paid in the only currency he wants. And when the thing that has been
 * circling Peter for three books finally takes him, the city is left with a
 * seventeen-year-old and a radio.
 */
export const CHAPTER_BEATS: Readonly<Record<string, ChapterBeats>> = {
  // ---------------------------------------------------- Book One: Nine Lives
  'Shift Change': {
    open: [
      ['YURI', 'Spider-Man, it is Watanabe. The radio is already busy and the sun is not even down.'],
      ['HERO', 'Good to know I was missed.'],
      ['YURI', 'I did not say missed. I said busy.'],
    ],
    mid: [['YURI', 'One call cleared. The precinct is pretending very hard not to notice.']],
    close: [
      ['MJ', 'The Bugle wants a photograph of you working. Try to look heroic.'],
      ['HERO', 'As opposed to?'],
      ['MJ', 'As opposed to somebody who slept on a roof again.'],
    ],
  },
  'Light Fingers': {
    open: [
      ['MJ', 'Nine burglaries this week. No forced doors, no alarms, nothing on any camera.'],
      ['HERO', 'So either a ghost, or somebody very good.'],
      ['MJ', 'The Bugle is going with ghost. I am going with very good.'],
    ],
    mid: [['YURI', 'Another one, same four blocks. Whoever this is, they are enjoying themselves.']],
    close: [
      ['HERO', 'Every address she hit is leased by the same holding company.'],
      ['MJ', 'Osborn. It is always Osborn eventually.'],
    ],
  },
  'Rooftop Pursuit': {
    open: [['YURI', 'Roof alarm on the Vanderbilt tower. She tripped it on the way out. She wanted us to watch.']],
    meet: {
      'BLACK CAT': [
        ['BLACK CAT', 'You are late. I have had this roof to myself for twenty minutes.'],
        ['HERO', 'You could just stop running.'],
        ['BLACK CAT', 'And ruin the only fun either of us gets? Keep up.'],
      ],
    },
    down: {
      'BLACK CAT': [
        ['BLACK CAT', 'Not bad. You are faster than the file said you were.'],
        ['HERO', 'There is a file?'],
        ['BLACK CAT', 'There is always a file.'],
      ],
    },
    close: [
      ['HERO', 'She was carrying something that was not jewellery, and she left it behind.'],
      ['MJ', 'Then she left it on purpose. People that good do not drop things.'],
    ],
  },
  'What She Left': {
    open: [
      ['MJ', 'It is a key card. Osborn security, issued to a laboratory that officially does not exist.'],
      ['HERO', 'She wanted me to have it.'],
      ['MJ', 'Which means somebody wants you looking at Osborn. Be careful whose errand you are running.'],
    ],
    mid: [['MAY', 'The shelter is full again tonight. Come by when the city lets you.']],
    close: [
      ['MAY', 'You look tired.'],
      ['HERO', 'It is a tired city.'],
      ['MAY', 'Then eat something before you go back out into it.'],
    ],
  },
  'Second Story': {
    open: [
      ['HERO', 'She is coming back for the card.'],
      ['PARTNER', 'Then we let her reach it, and we follow her out.'],
      ['HERO', 'You have been reading my mail.'],
    ],
    turn: {
      'BLACK CAT': [
        ['BLACK CAT', 'Two of you, and I am still ahead. Think about that.'],
        ['PARTNER', 'She is not wrong.'],
      ],
    },
    meet: {
      'BLACK CAT': [
        ['BLACK CAT', 'Two of you. I am flattered and slightly insulted.'],
        ['PARTNER', 'You should be mostly insulted.'],
      ],
    },
    down: {
      'BLACK CAT': [
        ['BLACK CAT', 'Take it. It was never going to be worth what he paid me.'],
        ['HERO', 'Who paid you, Felicia?'],
        ['BLACK CAT', 'Ask me again when you can afford the answer.'],
      ],
    },
    close: [
      ['MJ', 'She is working for somebody with money and patience.'],
      ['HERO', 'That narrows it to about nine people in this city.'],
      ['MJ', 'Eight. One of them is in prison.'],
    ],
  },

  // ------------------------------------------------------ Book Two: Brownout
  Flicker: {
    open: [
      ['YURI', 'The grid is dropping whole blocks. The utility says nothing is broken.'],
      ['HERO', 'Then somebody is taking it.'],
      ['YURI', 'Crews are working the dark. Go and make that expensive.'],
    ],
    mid: [['YURI', 'Three blocks black, and every alarm inside them is dead.']],
    close: [['JAMESON', 'The lights go out and the wall-crawler appears. You do the arithmetic. I already have.']],
  },
  'Load Bearing': {
    open: [
      ['MJ', 'The substations are not failing. They are being drained in order, west to east.'],
      ['HERO', 'Following a line.'],
      ['MJ', 'Following a man. Maxwell Dillon. Lineman. Hurt on an Osborn contract, paid nothing.'],
    ],
    mid: [['YURI', 'Stay off the wires. I am not writing that report.']],
    close: [['HERO', 'He is not stealing power. He is billing them for it, one substation at a time.']],
  },
  'Live Wire': {
    open: [['YURI', 'He is standing on top of the substation and he is not coming down. Nothing we have reaches him.']],
    meet: {
      ELECTRO: [
        ['ELECTRO', 'Nine years I climbed those towers. Nine years.'],
        ['HERO', 'I know. I read the file.'],
        ['ELECTRO', 'Then you know nobody came. Nobody ever comes.'],
      ],
    },
    down: {
      ELECTRO: [
        ['ELECTRO', 'It does not switch off. It is inside me now.'],
        ['HERO', 'We will find somebody who can help.'],
        ['ELECTRO', 'They had ten years to help.'],
      ],
    },
    close: [['MJ', 'The lights are back. Nobody at Osborn has returned a single call.']],
  },
  'Cold Start': {
    open: [['MAY', 'We ran the shelter on candles for two nights, and people were kind. That is worth saying out loud.']],
    mid: [['YURI', 'Quiet shift. Do not jinx it.']],
    close: [
      ['HERO', 'Dillon was contract labour, under a subcontractor.'],
      ['MJ', 'So there is no paper anywhere with his name on it. There never is.'],
    ],
  },
  'Ground Fault': {
    open: [
      ['HERO', 'He is out.'],
      ['PARTNER', 'Out, and charging. Somebody posted his bail inside an hour.'],
      ['HERO', 'Somebody with money and patience.'],
    ],
    turn: {
      ELECTRO: [['ELECTRO', 'You think grounding me ends it? It ends when they pay.']],
    },
    meet: {
      ELECTRO: [
        ['ELECTRO', 'You brought a friend. I brought the grid.'],
        ['PARTNER', 'That is a lot of grid.'],
      ],
    },
    down: {
      ELECTRO: [
        ['ELECTRO', 'He said he could fix me. He said it would be quick.'],
        ['HERO', 'Who did?'],
        ['ELECTRO', 'The man who never signs anything.'],
      ],
    },
    close: [['JAMESON', 'Two masked men on a substation roof. Two! Where does a city put in a complaint?']],
  },

  // ------------------------------------- Book Three: Something In The Dark
  'Bad Nights': {
    open: [
      ['YURI', 'Four people taken off the street this week. Two are talking. Neither of them makes sense.'],
      ['HERO', 'What are they saying?'],
      ['YURI', 'That it was big, it was black, and it knew their names.'],
    ],
    mid: [['DANIKA', 'Okay, Spider-watchers, something is out there and it is not one of the regulars.']],
    close: [['HERO', 'Whatever it is, it is not hunting for money.']],
  },
  'It Knows You': {
    open: [
      ['HERO', 'It has been on my roof.'],
      ['MJ', 'Which roof?'],
      ['HERO', 'Mine. The one with my name on the lease.'],
    ],
    mid: [['GANKE', 'The camera on your fire escape just went black. Not off. Black.']],
    close: [['HERO', 'It is not following the city. It is following me.']],
  },
  Teeth: {
    open: [['YURI', 'Whatever you are about to do, do it somewhere I can send an ambulance.']],
    meet: {
      VENOM: [
        ['VENOM', 'We know you. We know what you are underneath.'],
        ['HERO', 'Everybody knows a man in a mask.'],
        ['VENOM', 'We knew you before the mask.'],
      ],
    },
    down: {
      VENOM: [
        ['VENOM', 'You cannot kill us. We are already yours.'],
        ['HERO', 'Stay down.'],
      ],
    },
    close: [['HERO', 'It said we. Every single time. We.']],
  },
  'Quiet Streets': {
    open: [['MAY', 'Sit down for ten minutes. The city will still be there when you stand up.']],
    mid: [['MJ', 'Osborn Industries filed a biohazard incident nine months ago. One line long. No detail.']],
    close: [['HERO', 'Nine months ago is when the bad nights started.']],
  },
  Feeding: {
    open: [
      ['PARTNER', 'It came to my window last night. Not yours. Mine.'],
      ['HERO', 'Then it is choosing. That is worse.'],
    ],
    turn: {
      VENOM: [['VENOM', 'It hurts. Good. Now you know what we are.']],
    },
    meet: {
      VENOM: [
        ['VENOM', 'Two of you. Better. We were still hungry.'],
        ['PARTNER', 'That is genuinely the worst thing anyone has ever said to me.'],
      ],
    },
    down: {
      VENOM: [['VENOM', 'We will find a warmer one.']],
    },
    close: [['HERO', 'It did not lose. It left.']],
  },

  // -------------------------------------- Book Four: Something In The Sky
  Ordnance: {
    open: [
      ['YURI', 'A corner store was robbed last night with military breaching charges.'],
      ['HERO', 'Where does a corner store stick-up find ordnance?'],
      ['YURI', 'That is the question I am not allowed to ask on an open channel.'],
    ],
    mid: [['JAMESON', 'Somebody is arming our streets, and our masked friend is very busy being photographed!']],
    close: [
      ['MJ', 'Serial numbers ground off, but the casing polymer is proprietary. One manufacturer makes it.'],
      ['HERO', 'Let me guess.'],
    ],
  },
  'Flight Path': {
    open: [['DANIKA', 'Three separate people filmed something with wings over the East Side last night. Three.']],
    mid: [['YURI', 'Air traffic has a return they cannot explain. It moves like nothing that should be flying.']],
    close: [['HERO', 'It is not a drone. Drones do not laugh.']],
  },
  'Trick Or Treat': {
    open: [['YURI', 'Whatever is up there has already put two helicopters down. Do not let it reach the bridge.']],
    meet: {
      'GREEN GOBLIN': [
        ['GREEN GOBLIN', 'There he is. The only honest man in the city, and he wears a mask.'],
        ['HERO', 'Osborn.'],
        ['GREEN GOBLIN', 'Mister Osborn. I built half of what you are standing on.'],
      ],
    },
    down: {
      'GREEN GOBLIN': [['GREEN GOBLIN', 'You have not won anything. You have only been noticed.']],
    },
    close: [['MJ', 'Norman Osborn. On the record I have nothing. Off the record I have all of it.']],
  },
  Fallout: {
    open: [['YURI', 'Six blocks damaged, forty injured, nobody dead. That last part is you.']],
    mid: [['MAY', 'Twenty new beds arrived and there is no room for them. Come and move furniture, hero.']],
    close: [['JAMESON', 'Where was Spider-Man? Late! Where is Norman Osborn? Rebuilding! Print that.']],
  },
  'Bought And Paid For': {
    open: [
      ['HERO', 'She is on his payroll. She has been the whole time.'],
      ['PARTNER', 'And she has been handing us the truth on his money. That is not nothing.'],
    ],
    turn: {
      'BLACK CAT': [['BLACK CAT', 'For the record, I am aiming badly on purpose.']],
      'GREEN GOBLIN': [
        ['GREEN GOBLIN', 'Felicia. Do something useful or I stop paying you.'],
        ['BLACK CAT', 'I am busy.'],
      ],
    },
    banter: [
      ['GREEN GOBLIN', 'You were supposed to be a distraction, Felicia.'],
      ['BLACK CAT', 'I am a very good one.'],
    ],
    meet: {
      'BLACK CAT': [
        ['BLACK CAT', 'Do not look at me like that.'],
        ['HERO', 'You took his money.'],
        ['BLACK CAT', 'I took his money and gave you his key card. Decide which half matters.'],
      ],
      'GREEN GOBLIN': [['GREEN GOBLIN', 'Everyone in this city is for sale. She was cheap.']],
    },
    down: {
      'BLACK CAT': [['BLACK CAT', 'Go and get him. I will be gone before the sirens.']],
      'GREEN GOBLIN': [['GREEN GOBLIN', 'Tell them whatever you like. Nobody believes a mask.']],
    },
    close: [['MJ', 'He walks. Of course he walks.']],
  },

  // ------------------------------------------------ Book Five: Ground Truth
  Foundations: {
    open: [
      ['YURI', 'Three building sites hit, nothing taken. The ground itself is gone.'],
      ['HERO', 'Gone where?'],
      ['YURI', 'That is what I am asking you.'],
    ],
    mid: [['GANKE', 'The fill under all three sites came from one quarry upstate. Guess who holds the lease.']],
    close: [['MJ', 'Flint Marko. Nine years for a robbery he has always said he did not do.']],
  },
  Aggregate: {
    open: [
      ['MJ', 'Marko has a daughter. She is fourteen. He has not seen her since the trial.'],
      ['HERO', 'So he is not doing this for money.'],
    ],
    mid: [['YURI', 'Whatever came through that wall did not use the door and did not leave a footprint.']],
    close: [['HERO', 'He is not robbing these sites. He is digging under them.']],
  },
  Quarry: {
    open: [['YURI', 'He is standing in the middle of the avenue and the traffic is going around him.']],
    meet: {
      SANDMAN: [
        ['SANDMAN', 'I am not here for you.'],
        ['HERO', 'You are in the middle of an avenue, Flint.'],
        ['SANDMAN', 'Then move the avenue.'],
      ],
    },
    down: {
      SANDMAN: [
        ['SANDMAN', 'They said they could put me back. Just one job first.'],
        ['HERO', 'It is always one more job.'],
      ],
    },
    close: [['HERO', 'One job for who, Flint?']],
  },
  Settling: {
    open: [['MAY', 'There is sand in the soup and sand in the sheets. Come and dig us out.']],
    mid: [['JAMESON', 'A man made of dirt walks down Lexington and the police call a teenager! A teenager!']],
    close: [['MJ', 'The quarry lease is Osborn. Naturally.']],
  },
  'Clear Ground': {
    open: [['YURI', 'Quiet day. Enjoy it, and keep an eye on the drains.']],
    mid: [['DANIKA', 'Is it strange that the city feels calm and I hate it? It feels like being watched.']],
    close: [['HERO', 'He has been underneath us this whole time.']],
  },
  Sinkhole: {
    open: [
      ['PARTNER', 'The reservoir level is dropping. Fast.'],
      ['HERO', 'He is not hiding down there. He is drinking.'],
    ],
    turn: {
      SANDMAN: [['SANDMAN', 'Stop hitting my head. That is the only part that hurts.']],
      'GREEN GOBLIN': [['GREEN GOBLIN', 'Deeper, Mister Marko! Take the whole block!']],
    },
    banter: [
      ['GREEN GOBLIN', 'Faster, Mister Marko.'],
      ['SANDMAN', 'I am not your dog.'],
      ['GREEN GOBLIN', 'You are whatever I have paid for.'],
    ],
    meet: {
      SANDMAN: [['SANDMAN', 'I only want to go home.']],
      'GREEN GOBLIN': [['GREEN GOBLIN', 'Then earn it, Mister Marko. Bury them and I will drive you there myself.']],
    },
    down: {
      SANDMAN: [['SANDMAN', 'Tell her I tried.']],
      'GREEN GOBLIN': [['GREEN GOBLIN', 'You have cost me a very expensive man.']],
    },
    close: [['HERO', 'He used a father to move a block of dirt, and he thinks that was clever.']],
  },

  // -------------------------------------------------- Book Six: The Poison
  'Something Is Wrong': {
    open: [
      ['MILES', 'Something is wrong with Peter.'],
      ['MJ', 'Define wrong.'],
      ['MILES', 'He put a man through a door over a stolen phone. He did not even blink.'],
    ],
    mid: [['MJ', 'Talk to him. Not as Spider-Man. As you.']],
    close: [['MILES', 'He told me he has never felt better. He said it like a threat.']],
  },
  Hairline: {
    open: [['MAY', 'He did not come to dinner. He always comes to dinner.']],
    mid: [['GANKE', 'His suit telemetry is off the scale. Strength, output, all of it. That is not training.']],
    close: [['MILES', 'The black is not a suit. It is on him.']],
  },
  'The Bite': {
    open: [
      ['MILES', 'There is a mark on the alley wall, like something tore itself free.'],
      ['MJ', 'And Peter?'],
      ['MILES', 'Gone.'],
    ],
    mid: [['YURI', 'We have reports of a Spider-Man breaking arms. That is not you, and it is not funny.']],
    close: [['MILES', 'It had him for days and I did not see it.']],
  },
  'Wrong Hands': {
    open: [
      ['RIO', 'Miles. Whatever this is, you do not carry it on your own. Understood?'],
      ['MILES', 'Understood, Ma.'],
    ],
    mid: [['GANKE', 'You are out there alone and I hate every second of it.']],
    close: [['MILES', 'He is not hiding from me. He is waiting for me to find him.']],
  },
  'Not Him': {
    open: [['MJ', 'Whatever is wearing him knows everything he knows. Including you.']],
    turn: {
      'SYMBIOTE PETER': [
        ['SYMBIOTE PETER', 'You are still holding back. He would not have.'],
        ['MILES', 'He would. That is the entire point of him.'],
      ],
    },
    meet: {
      'SYMBIOTE PETER': [
        ['SYMBIOTE PETER', 'There he is. The kid who was always going to be better than me.'],
        ['MILES', 'You are not him.'],
        ['SYMBIOTE PETER', 'I am all of him, with the flinching taken out.'],
      ],
    },
    down: {
      'SYMBIOTE PETER': [['SYMBIOTE PETER', 'You pulled some of it off. Good. Now do it again in an hour.']],
    },
    close: [['MILES', 'He looked at me. For one second it was actually him.']],
  },
  'Bring Him Back': {
    open: [
      ['MJ', 'If you get him down, keep him down. It hates sound. High frequency, sustained.'],
      ['MILES', 'Understood.'],
    ],
    turn: {
      'SYMBIOTE PETER': [
        ['SYMBIOTE PETER', 'The sound. Turn it off. Turn it off.'],
        ['MILES', 'No.'],
      ],
    },
    meet: {
      'SYMBIOTE PETER': [['SYMBIOTE PETER', 'No more pretending to be him. He was slowing me down.']],
    },
    down: {
      'SYMBIOTE PETER': [
        ['SYMBIOTE PETER', 'It hurts. Miles, it hurts.'],
        ['MILES', 'I know. Stay down. I am right here.'],
      ],
    },
    close: [['MILES', 'Not out. But closer than yesterday.']],
  },
  'Two Against': {
    open: [
      ['MILES', 'There are two of them now.'],
      ['MJ', 'Then it split.'],
      ['MILES', 'It multiplied.'],
    ],
    turn: {
      VENOM: [['VENOM', 'The little one hits harder than the old one ever did.']],
      'SYMBIOTE PETER': [['SYMBIOTE PETER', 'Miles. Do not stop.']],
    },
    banter: [
      ['VENOM', 'Brother. Come away from him.'],
      ['SYMBIOTE PETER', 'He is mine.'],
      ['VENOM', 'Everything is ours.'],
    ],
    meet: {
      VENOM: [['VENOM', 'We are the older one. He is only a copy.']],
      'SYMBIOTE PETER': [['SYMBIOTE PETER', 'Do not make me choose, kid. You will not like the answer.']],
    },
    down: {
      VENOM: [['VENOM', 'You are alone now, little spider.']],
      'SYMBIOTE PETER': [['SYMBIOTE PETER', 'Miles. The sound. Use the sound.']],
    },
    close: [['MILES', 'Peter is out. He is breathing. He is out.']],
  },

  // --------------------------------------- Book Seven: All Of Them At Once
  'The Cat Comes Back': {
    open: [
      ['PARTNER', 'She called this one in herself.'],
      ['HERO', 'That is new.'],
    ],
    meet: {
      'BLACK CAT': [['BLACK CAT', 'Do not thank me. Hit me once, it has to look real from the street.']],
    },
    down: {
      'BLACK CAT': [
        ['BLACK CAT', 'He is putting the whole roster back out tonight. All of them, all at once.'],
        ['HERO', 'Why tell us?'],
        ['BLACK CAT', 'Because I live here too.'],
      ],
    },
    close: [['HERO', 'She burned her own payday to warn us.']],
  },
  'Full Charge': {
    open: [['YURI', 'Every substation in the borough came online at the same instant. That is not a fault.']],
    meet: {
      ELECTRO: [['ELECTRO', 'He gave me the whole grid. All of it, at once.']],
    },
    down: {
      ELECTRO: [['ELECTRO', 'He never fixed anything. He only made it bigger.']],
    },
    close: [['HERO', 'One down. The rest of them are already moving.']],
  },
  'Feeding Again': {
    open: [['GANKE', 'It found a new host in twenty minutes. Twenty.']],
    meet: {
      VENOM: [['VENOM', 'We always find a warmer one.']],
    },
    down: {
      VENOM: [['VENOM', 'There is more of us than you can carry.']],
    },
    close: [['HERO', 'Burn it. All of it, this time.']],
  },
  'The Whole Sky': {
    open: [
      ['JAMESON', 'Norman Osborn is a great man and I will say so on any channel that -- wait. What is that?'],
      ['JAMESON', 'Get the camera up. Get the camera up!'],
    ],
    meet: {
      'GREEN GOBLIN': [['GREEN GOBLIN', 'I gave this city everything I had. It gave me a mask in return.']],
    },
    down: {
      'GREEN GOBLIN': [['GREEN GOBLIN', 'You cannot arrest what a city needs.']],
    },
    close: [['MJ', 'It is filed. Front page, morning edition, his name across all of it.']],
  },
  Immovable: {
    open: [['HERO', 'Flint. Last chance to walk away from him.']],
    meet: {
      SANDMAN: [['SANDMAN', 'He has my daughter address. He read it out to me.']],
    },
    down: {
      SANDMAN: [['SANDMAN', 'Go. Go and get him.']],
    },
    close: [['HERO', 'Somebody get that man a phone call.']],
  },
  Everything: {
    open: [
      ['RIO', 'Come home tonight, Miles.'],
      ['MILES', 'One roof. Both of them. Okay.'],
    ],
    turn: {
      'SYMBIOTE PETER': [['SYMBIOTE PETER', 'I can feel it letting go. Keep going.']],
      'GREEN GOBLIN': [['GREEN GOBLIN', 'Stand up, Parker! I did not build you to lose!']],
    },
    banter: [
      ['GREEN GOBLIN', 'Kill the boy and I will let you keep the man.'],
      ['SYMBIOTE PETER', 'You do not get to give me anything.'],
    ],
    meet: {
      'SYMBIOTE PETER': [['SYMBIOTE PETER', 'You keep saving me. Stop.']],
      'GREEN GOBLIN': [['GREEN GOBLIN', 'Finish each other and save me the trouble.']],
    },
    down: {
      'GREEN GOBLIN': [['GREEN GOBLIN', 'This city -- I made it --']],
      'SYMBIOTE PETER': [['SYMBIOTE PETER', 'Miles? Did I -- what did I do?']],
    },
    close: [
      ['MILES', 'It is over.'],
      ['PETER', 'It is not over. It is just quiet.'],
      ['MILES', 'I will take quiet.'],
    ],
  },
};

// ------------------------------------------------------------------- radio

/** An ambient segment, and the earliest book it makes sense in. */
export interface Ambient {
  /** 0-based book index this unlocks at. */
  readonly book: number;
  readonly script: Script;
}

/**
 * Just Facts With J Jonah Jameson, and everyone else with a microphone.
 *
 * These play between fights when nothing else is happening, gated by how far
 * through the books the player is, so the radio is always talking about a city
 * the player recognises rather than one three books behind.
 */
export const AMBIENT: readonly Ambient[] = [
  { book: 0, script: [['JAMESON', 'Just facts. A masked man is on our rooftops and nobody elected him. Fact!']] },
  { book: 0, script: [['MAY', 'Whoever is listening: there is soup at the shelter and it is better than it sounds.']] },
  { book: 0, script: [['DANIKA', 'Day forty of a man swinging past my window at four in the morning. I am fine.']] },
  { book: 0, script: [['YURI', 'Radio is calm. That is either good news or the other kind.']] },
  {
    book: 1,
    script: [
      ['MJ', 'You are on a roof again, are you not.'],
      ['HERO', 'It is a very good roof.'],
    ],
  },
  { book: 1, script: [['JAMESON', 'The grid fails and the wall-crawler is there in minutes. Minutes! Ask how.']] },
  { book: 1, script: [['GANKE', 'For the record, I have now done more homework for you than for me.']] },
  { book: 2, script: [['DANIKA', 'People keep sending me clips of something big on the rooftops. I do not love it.']] },
  { book: 2, script: [['MAY', 'Two of the beds tonight are people who were taken and let go again. Be careful.']] },
  {
    book: 2,
    script: [
      ['YURI', 'Spider-Man. Whatever this thing is, my officers cannot fight it.'],
      ['HERO', 'Then keep them off the roofs.'],
    ],
  },
  { book: 3, script: [['JAMESON', 'Norman Osborn rebuilt six blocks out of his own pocket. Where were you? A roof!']] },
  { book: 3, script: [['MJ', 'Everything I file about Osborn comes back with the legal department attached.']] },
  { book: 5, script: [['RIO', 'Miles, dinner is at seven, and the city can wait fifteen minutes for once.']] },
  { book: 4, script: [['GANKE', 'The quarry paperwork runs through four shell companies and then stops. Neat.']] },
  { book: 5, script: [['DANIKA', 'The friendly one has not been friendly lately, and I am not the only one saying it.']] },
  {
    book: 5,
    script: [
      ['MJ', 'Miles. You are not responsible for what it does with his hands.'],
      ['MILES', 'I know.'],
      ['MJ', 'You do not, but say it back to me anyway.'],
    ],
  },
  { book: 5, script: [['JAMESON', 'Spider-Man attacked a man in broad daylight! I have said this for years!']] },
  { book: 6, script: [['YURI', 'Every unit in the borough is out tonight. Tell me where to put them.']] },
  { book: 6, script: [['MAY', 'The doors here stay open. Whoever needs them. Whichever of you needs them.']] },
];

/**
 * Police-radio callouts, keyed by what is actually happening.
 *
 * Dispatch used to read from one flat list, so the radio described a mugging
 * and a heist in the same words. Keying it by kind means the call tells the
 * player what they are flying into — which is the only reason to have a radio.
 */
export const DISPATCH: Readonly<Record<CrimeKind, readonly Script[]>> = {
  MUGGING: [
    [['YURI', 'Assault in progress, two blocks north of you. Somebody is on the ground.']],
    [['YURI', 'Mugging called in by a neighbour. Nearest unit is nine minutes out. That is your cue.']],
  ],
  SHAKEDOWN: [
    [['YURI', 'They are leaning on a shop front in the open. They are not even hiding any more.']],
    [['YURI', 'Same crew, third call tonight. Somebody is paying them to stay busy.']],
  ],
  HEIST: [
    [['YURI', 'Crew mid-job and armed. If they get to the street they are gone.']],
    [['YURI', 'Shots called in. No injuries yet, and I would like to keep it that way.']],
  ],
  AMBUSH: [
    [['YURI', 'Four of them on a roof and nothing to rob. That is a welcome party.']],
    [['YURI', 'This one is waiting for you. Go in expecting it.']],
  ],
};

/** When the clock runs out. Said once, without labouring it. */
export const CRIME_LOST: readonly Script[] = [
  [['YURI', 'They are gone. It happens. Next one.']],
  [
    ['YURI', 'We lost that one.'],
    ['HERO', 'I know.'],
  ],
  [['YURI', 'Too slow. Do not carry it — there is another call already.']],
];

// ------------------------------------------------------------- in the fight

/**
 * What a villain says when the fight turns against them.
 *
 * Fires once, the first time they drop below half health, and is the generic
 * bank — a chapter with something specific to say at that moment overrides it
 * with its own `turn`. Living here rather than only on chapters means free
 * roam and the post-game siege get it too, which is most of the time a player
 * spends fighting these six.
 */
export const TURN: Partial<Record<VillainKind, Script>> = {
  'BLACK CAT': [['BLACK CAT', 'All right. You have my attention now.']],
  ELECTRO: [['ELECTRO', 'You want to know what nine years feels like? Stand still.']],
  SANDMAN: [['SANDMAN', 'You cannot hit what does not stay hit.']],
  VENOM: [['VENOM', 'We bleed. We have never bled.']],
  'GREEN GOBLIN': [['GREEN GOBLIN', 'Oh, this is marvellous. Do that again.']],
  'SYMBIOTE PETER': [['SYMBIOTE PETER', 'Hit me properly or get out of my city.']],
};

/**
 * What they say when *you* are nearly down.
 *
 * The moment a fight is going badly is the moment the game is least readable —
 * a health bar in the corner is not much of a warning. A villain gloating is
 * both a story beat and a very clear one.
 */
export const PRESSURE: Partial<Record<VillainKind, Script>> = {
  'BLACK CAT': [
    ['BLACK CAT', 'Stay down. I am serious, stay down.'],
    ['YURI', 'Spider-Man, disengage. That is not a request.'],
  ],
  ELECTRO: [['ELECTRO', 'Everything ends grounded.']],
  SANDMAN: [
    ['SANDMAN', 'Just stop. I do not want this.'],
    ['HERO', 'Neither do I, Flint.'],
  ],
  VENOM: [['VENOM', 'We can hear your heart slowing.']],
  'GREEN GOBLIN': [['GREEN GOBLIN', 'There it is. The part where you fall.']],
  'SYMBIOTE PETER': [
    ['SYMBIOTE PETER', 'Do not make me finish this, kid.'],
    ['MILES', 'Then do not.'],
  ],
};

/**
 * What is said when the player goes down.
 *
 * Losing used to be completely silent — the same full-health teleport whether
 * you had been beaten by Venom or had simply missed a web — so a player could
 * lose a fight without registering that anything had happened. The villain who
 * did it gets the last word, which is both the story beat and the clearest
 * possible statement of what just went wrong.
 */
export const DEFEAT: Partial<Record<VillainKind, Script>> = {
  'BLACK CAT': [
    ['BLACK CAT', 'Oh, get up. You are embarrassing us both.'],
    ['YURI', 'Spider-Man. Answer me.'],
  ],
  ELECTRO: [['ELECTRO', 'Now you know. Now you know what it felt like.']],
  SANDMAN: [
    ['SANDMAN', 'I told you to stay down.'],
    ['YURI', 'Fall back. That is an order I cannot give you, but fall back.'],
  ],
  VENOM: [['VENOM', 'Sleep. We will still be hungry when you wake.']],
  'GREEN GOBLIN': [['GREEN GOBLIN', 'Marvellous. Do get up, I was enjoying that.']],
  'SYMBIOTE PETER': [
    ['SYMBIOTE PETER', 'I did not want to do that.'],
    ['MILES', 'Yes you did.'],
  ],
};

/** Nobody beat you — the city did. */
export const FALL: Script = [
  ['YURI', 'We lost you off the radio for a moment there. Say something.'],
  ['HERO', 'Still here. Mostly.'],
];

// ------------------------------------------------------------- book endings

/**
 * The last word on a book, played after its final chapter closes and before
 * the next book opens.
 *
 * A book is the unit this story is actually told in, and without these the
 * only signal that one had ended was the chapter counter resetting.
 */
export const BOOK_ENDINGS: Readonly<Record<string, Script>> = {
  'Book One': [
    ['MJ', 'One key card, one thief with a conscience, and the same name under all of it.'],
    ['HERO', 'Osborn.'],
    ['MJ', 'Osborn. Get some sleep. We start on him tomorrow.'],
  ],
  'Book Two': [
    ['YURI', 'Dillon is in a cell that costs more than this precinct. Somebody insisted.'],
    ['HERO', 'Somebody who never signs anything.'],
  ],
  'Book Three': [
    ['HERO', 'It is still out there.'],
    ['MJ', 'It is still out there, and it still says we.'],
    ['MAY', 'Then eat first. It can wait an hour.'],
  ],
  'Book Four': [
    ['JAMESON', 'Norman Osborn, a glider, and forty people in hospital. I am printing one correction. One!'],
    ['MJ', 'The story is real. It is just not printable yet.'],
  ],
  'Book Five': [
    ['HERO', 'Marko goes back inside, and his daughter still does not get a visit.'],
    ['MJ', 'That is the part nobody writes down.'],
  ],
  'Book Six': [
    ['MILES', 'He is asleep. Actually asleep.'],
    ['MJ', 'You did that.'],
    ['MILES', 'We did that.'],
  ],
  'Book Seven': [
    ['YURI', 'Six of them in one night, and the city is still standing.'],
    ['PETER', 'Give it a week.'],
    ['MILES', 'Give it an hour.'],
  ],
};

// ------------------------------------------------------------------- siege

/**
 * The post-game, which used to happen in total silence.
 *
 * One segment per wave, in order, and then it stops — an endless mode
 * narrating itself forever becomes wallpaper, and the last line is written to
 * be the last thing the city has to say about it.
 */
export const SIEGE: readonly Script[] = [
  [['YURI', 'Every one of them is out of custody on the same night. That is not a coincidence.']],
  [['JAMESON', 'They are back! All of them! I told this city and this city did not listen!']],
  [['MJ', 'Whoever is paying for this has stopped pretending it is deniable.']],
  [['MAY', 'The shelter is full and the doors are staying open. Do what you have to do.']],
  [['DANIKA', 'I am broadcasting from a roof and I regret every decision that led me here.']],
  [['GANKE', 'Six hostiles. Six. I have officially run out of jokes.']],
  [
    ['YURI', 'I have nothing left to send you.'],
    ['HERO', 'Then it is me. Fine. It is always me.'],
  ],
];

// ------------------------------------------------------------- side threads

/**
 * A thread running underneath the books.
 *
 * Each is a short arc that advances on cleared crime rather than on chapters,
 * so the city keeps a life of its own between bosses. They are the one part of
 * the story a player can miss entirely by rushing, which is what makes
 * finishing one feel like something.
 */
export interface Thread {
  readonly title: string;
  /** 0-based book this becomes eligible in. */
  readonly book: number;
  readonly beats: readonly Script[];
}

export const THREADS: readonly Thread[] = [
  {
    title: 'The Shelter',
    book: 0,
    beats: [
      [['MAY', 'We took in eleven people last night and turned four away. I hate the four.']],
      [
        ['MAY', 'A man came in with a burn nobody could explain. He would not say where.'],
        ['HERO', 'What kind of burn?'],
        ['MAY', 'The kind that runs in a straight line.'],
      ],
      [
        ['MAY', 'The boiler has died. Of course it has.'],
        ['HERO', 'I can look at it tonight.'],
        ['MAY', 'You can look at it after you have slept.'],
      ],
      [
        ['MAY', 'Somebody paid the whole heating bill anonymously. A very large somebody.'],
        ['HERO', 'Do not cash it.'],
        ['MAY', 'I already have. People were cold.'],
      ],
      [['MAY', 'The doors stayed open all winter. Whatever else happens out there, write that down.']],
    ],
  },
  {
    title: 'On Air',
    book: 1,
    beats: [
      [['DANIKA', 'New segment: is the man in the mask actually helping? Comments are, shall we say, mixed.']],
      [['DANIKA', 'Update. He took a bus door off with his hands to reach a child. Comments are less mixed.']],
      [['DANIKA', 'Somebody sent me a very polite legal letter about the word Osborn. Strange!']],
      [['DANIKA', 'I am not taking the segment down, and I would like that on the record.']],
      [['DANIKA', 'Fifty thousand of you now. Be kind to each other, and look up occasionally.']],
    ],
  },
  {
    title: 'The Piece',
    book: 3,
    beats: [
      [['MJ', 'I have a source inside the contracting arm. Terrified, but talking.']],
      [
        ['MJ', 'Legal killed the draft. That is twice.'],
        ['HERO', 'So what now?'],
        ['MJ', 'Now I write a better one.'],
      ],
      [
        ['MJ', 'My source has stopped answering. Can you look at an address for me?'],
        ['HERO', 'Send it.'],
      ],
      [['MJ', 'She is fine. She moved, and she left a box of paper behind. Very kind of her.']],
      [['MJ', 'It runs. Whatever else happens tonight, the piece runs.']],
    ],
  },
  {
    title: 'Harlem',
    book: 5,
    beats: [
      [['RIO', 'The block association wants a mural. I said my son knows people who climb.']],
      [
        ['GANKE', 'You have been out six nights running. I am telling your mother.'],
        ['MILES', 'You would not.'],
        ['GANKE', 'I absolutely would.'],
      ],
      [
        ['RIO', 'Mrs Ortega asked after you by name. Your other name.'],
        ['MILES', 'Okay. Okay.'],
        ['RIO', 'She thinks it is wonderful. Breathe.'],
      ],
      [['RIO', 'Whatever this city calls you, you come home and you eat. Both of those things.']],
    ],
  },
];

// ------------------------------------------------------------------- banks

/**
 * Every scripted line, grouped by speaker, in a stable order.
 *
 * `HERO` and `PARTNER` lines land in both hero banks, because either of them
 * may end up saying it. This is what lets a recorded clip pack cover story
 * dialogue the same way it covers barks: `Voice.line` is handed the index of
 * the line inside its speaker bank, exactly as `Voice.emit` hands over the
 * index it chose from a bark bank.
 */
function buildBanks(): Record<string, string[]> {
  const banks: Record<string, string[]> = {};
  const add = (speaker: string, text: string): void => {
    const bank = (banks[speaker] ??= []);
    if (!bank.includes(text)) bank.push(text);
  };
  const addScript = (script: Script): void => {
    for (const [who, text] of script) {
      if (who === 'HERO' || who === 'PARTNER') {
        add('PETER', text);
        add('MILES', text);
      } else {
        add(who, text);
      }
    }
  };

  for (const beats of Object.values(CHAPTER_BEATS)) {
    for (const script of [beats.open, beats.mid, beats.close, beats.banter]) if (script) addScript(script);
    for (const table of [beats.meet, beats.turn, beats.down]) {
      for (const script of Object.values(table ?? {})) if (script) addScript(script);
    }
  }
  for (const table of [TURN, PRESSURE, DEFEAT]) {
    for (const script of Object.values(table)) if (script) addScript(script);
  }
  addScript(FALL);
  for (const script of Object.values(BOOK_ENDINGS)) addScript(script);
  for (const script of SIEGE) addScript(script);
  for (const thread of THREADS) for (const script of thread.beats) addScript(script);
  for (const entry of AMBIENT) addScript(entry.script);
  for (const scripts of Object.values(DISPATCH)) for (const script of scripts) addScript(script);
  for (const script of CRIME_LOST) addScript(script);
  return banks;
}

/** Story dialogue as bark-shaped banks, for the offline clip renderer. */
export const STORY_LINES: Readonly<Record<string, readonly string[]>> = buildBanks();

// ---------------------------------------------------------------- director

/** How the queue treats a scene when something is already playing. */
export type ScenePriority = 'STORY' | 'AMBIENT';

/**
 * Reading pace. Long lines get longer, but nothing sits on screen forever and
 * nothing flashes past unread.
 */
function lineSeconds(text: string): number {
  const words = text.split(/\s+/).length;
  const seconds = 1.4 + words * 0.33;
  return seconds < 2.1 ? 2.1 : seconds > 6.5 ? 6.5 : seconds;
}

/**
 * Paces scripted scenes out one line at a time.
 *
 * Scenes queue rather than interrupt, because the moments that stack are
 * exactly the ones that matter: beating the last villain of a chapter fires
 * that villain going down, then the chapter closing, then the next chapter
 * opening, and playing all three at once would show the player only the third.
 * Ambient radio is the opposite — it is texture, so it is dropped outright
 * whenever anything else is waiting.
 */
type Entry = { readonly line: StoryLine } | { readonly card: StoryCard };

/** How long a title card holds the screen. */
const CARD_SECONDS = 2.8;

export class StoryDirector {
  /** Fires for each spoken line as it starts. */
  onLine: ((line: StoryLine) => void) | null = null;
  /** Fires for each interstitial card. */
  onCard: ((card: StoryCard) => void) | null = null;
  /** Fires once when the queue empties, so barks can be let back in. */
  onIdle: (() => void) | null = null;

  /**
   * Cap on queued scenes. A backlog longer than this is a bug, not a story.
   *
   * Sized against the real worst case rather than a round number, because the
   * cap silently drops whatever arrives past it and the burst it has to
   * survive is the most important moment in the game. A final boss falling at
   * the end of a chapter issues, in one synchronous callback: that villain's
   * defeat line, the chapter's closing exchange, the next chapter's title
   * card, a hero-change card if the next chapter forces one, its opening
   * exchange, and an arrival line for each villain it fields — seven for a
   * team-up. At four, the boss entrance and sometimes the opening exchange
   * were being thrown away exactly there.
   */
  private static readonly MAX_QUEUED = 12;

  private hero: HeroId = 'PETER';
  private readonly pending: Entry[][] = [];
  private current: Entry[] | null = null;
  private cursor = 0;
  private timer = 0;
  /** Stops `onIdle` firing on every frame after the queue drains. */
  private announcedIdle = true;

  /** True while a scene is playing or waiting to. */
  get busy(): boolean {
    return this.current !== null || this.pending.length > 0;
  }

  /** Who `HERO` resolves to. `PARTNER` is always the other one. */
  setHero(hero: HeroId): void {
    this.hero = hero;
  }

  /** Queues a scene. Returns false if there was nothing to play, or it was dropped. */
  play(script: Script | undefined, priority: ScenePriority = 'STORY'): boolean {
    if (!script || script.length === 0) return false;
    if (priority === 'AMBIENT' && this.busy) return false;
    if (this.pending.length >= StoryDirector.MAX_QUEUED) return false;

    const partner: HeroId = this.hero === 'PETER' ? 'MILES' : 'PETER';
    const lines = script.map(([who, text]): Entry => {
      const speaker: StorySpeaker = who === 'HERO' ? this.hero : who === 'PARTNER' ? partner : who;
      const bank = STORY_LINES[speaker];
      return { line: { speaker, text, clip: bank ? bank.indexOf(text) : -1, seconds: lineSeconds(text) } };
    });
    this.pending.push(lines);
    this.announcedIdle = false;
    return true;
  }

  /** Queues a title card in its proper place in the running order. */
  playCard(label: string, title: string): boolean {
    if (this.pending.length >= StoryDirector.MAX_QUEUED) return false;
    this.pending.push([{ card: { label, title, seconds: CARD_SECONDS } }]);
    this.announcedIdle = false;
    return true;
  }

  /** Abandons everything queued — used when a save loads or a mode restarts. */
  clear(): void {
    this.pending.length = 0;
    this.current = null;
    this.cursor = 0;
    this.timer = 0;
    this.announcedIdle = true;
  }

  update(dt: number): void {
    if (this.timer > 0) {
      this.timer -= dt;
      if (this.timer > 0) return;
      this.timer = 0;
    }

    if (this.current && this.cursor >= this.current.length) {
      this.current = null;
      this.cursor = 0;
    }

    if (!this.current) {
      const next = this.pending.shift();
      if (!next) {
        if (!this.announcedIdle) {
          this.announcedIdle = true;
          this.onIdle?.();
        }
        return;
      }
      this.current = next;
      this.cursor = 0;
    }

    const entry = this.current[this.cursor]!;
    this.cursor++;
    if ('card' in entry) {
      this.timer = entry.card.seconds;
      this.onCard?.(entry.card);
      return;
    }
    this.timer = entry.line.seconds;
    this.onLine?.(entry.line);
  }
}

// ------------------------------------------------------------ presentation

/**
 * Subtitle colour per speaker.
 *
 * Three groups, because that is the only distinction the player needs at a
 * glance: the people on your side, the people on the radio, and the ones
 * trying to kill you.
 */
const FRIENDLY = new Set<string>(['PETER', 'MILES', 'MJ', 'MAY', 'GANKE', 'RIO']);
const RADIO = new Set<string>(['YURI', 'JAMESON', 'DANIKA']);

export function speakerColor(speaker: string): string {
  if (FRIENDLY.has(speaker)) return '#52fa7c';
  if (RADIO.has(speaker)) return '#ffb703';
  return '#9440bc';
}

/** Display name for the subtitle line. */
const DISPLAY: Readonly<Record<string, string>> = {
  PETER: 'PETER',
  MILES: 'MILES',
  MJ: 'MARY JANE',
  MAY: 'AUNT MAY',
  YURI: 'WATANABE',
  JAMESON: 'JAMESON',
  GANKE: 'GANKE',
  RIO: 'RIO',
  DANIKA: 'DANIKA',
};

export function speakerName(speaker: string): string {
  return DISPLAY[speaker] ?? speaker;
}
