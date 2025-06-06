import { action, KeyAction, DialAction, DidReceiveSettingsEvent, KeyDownEvent, SingletonAction, streamDeck, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import sharp from "sharp";

const REFRESH_INTERVAL = 30000;

interface UniverseResponse {
	universeId: string
}

interface ThumbnailData {
	imageUrl: string,
	targetId: string,
}

interface UniverseData {
	id: string,
	playing: string,
}

interface ThumbnailResponse {
	data: [ThumbnailData]
}

interface UniverseDataResponse {
	data: [UniverseData]
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let activeActions: Set<string> = new Set<string>();

async function registerAction(actionId: string) {
	activeActions.add(actionId);
	if (activeActions.size > 0 && intervalId === null) {
		intervalId = setInterval(() => {
			let actions: (KeyAction | DialAction)[] = [];
			activeActions.forEach((actionId) => {
				let action = streamDeck.actions.getActionById(actionId);
				if (action) {
					actions.push(action);
				}
			});
			updateActions(actions);
		}, REFRESH_INTERVAL);
	}
}

async function unregisterAction(actionId: string) {
	activeActions.delete(actionId);
	if (activeActions.size === 0 && intervalId !== null) {
		clearInterval(intervalId);
		intervalId = null
	}
}

let updating: Set<string> = new Set<string>();

async function updateActions(actions: (KeyAction | DialAction)[]) {
	actions = actions.filter((action) => {return !updating.has(action.id)});
	if (actions.length === 0) {
		return;
	}
	actions.forEach((action) => {
		updating.add(action.id);
	});
	streamDeck.logger.info("============ Updating ============");
	streamDeck.logger.info(actions);
	let universeMap: Map<number, (KeyAction | DialAction)[]> = new Map(); 
	await Promise.all(actions.map(async (action: KeyAction | DialAction) => {
		const settings: CountSettings = await action.getSettings();
		const universe = await getUniverseFromPlace(settings.placeId || 0);
		let actions = universeMap.get(universe) || [];
		actions.push(action);
		universeMap.set(universe, actions);
	}));
	const universes = Array.from(universeMap.keys());
	const sterilizedUniverses: number[] = universes.filter((universe) => universe !== 0);
	await Promise.all([
		getThumbnails(sterilizedUniverses),
		getPlayerCounts(sterilizedUniverses),
	]).then(async ([thumbnails, counts]) => {
		sterilizedUniverses.forEach(async (universeId) => {
			const image = await addTextToImage(thumbnails.get(universeId) || "", counts.get(universeId) || "");
			let actions = universeMap.get(universeId) || [];
			actions.forEach((action) => {
				action.setImage(image);
			});
		});
		let blankActions = universeMap.get(0);
		if (blankActions) {
			blankActions.forEach((action) => {
				action.setImage("imgs/actions/player-count/icon");
			});
		}
	});
	actions.forEach((action) => {
		updating.delete(action.id);
	});
}

async function addTextToImage(base64: string, text: string) {
	const fontSize = 200/Math.max(text.length, 5);
	const svg = `
		<svg width="144" height="144" viewBox="0 0 144 144" xmlns="http://www.w3.org/2000/svg">
			<defs>
				<filter id="dropShadow" x="-50%" y="-50%" width="200%" height="200%">
					<feMorphology in="SourceAlpha" result="Thickened" operator="dilate" radius="2" />
					<feGaussianBlur in="Thickened" stdDeviation="3" />
					<feOffset dx="0" dy="0" result="offsetblur" />
					<feFlood flood-color="black" flood-opacity="1" />
					<feComposite in="offsetblur" operator="in" />
					<feMerge>
						<feMergeNode />
						<feMergeNode in="SourceGraphic" />
					</feMerge>
				</filter>
			</defs>
			<text
				x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-size="${fontSize}" fill="#fff" filter="url(#dropShadow)" style="font-family: 'Arial';" font-weight="700">${text}
			</text>
		</svg>
	`;
	const svgBuffer = Buffer.from(svg);
	const uri = base64.split(";base64,").pop() || "";
	const buffer = Buffer.from(uri, 'base64');
	const base = await sharp(buffer)
	.resize(144, 144)
	.modulate({ brightness: 0.8 })
	.blur(2)
	.composite([{ input: svgBuffer }])
	.png().toBuffer();
	return `data:image/png;base64,${base.toString('base64')}`;
}

async function getUniverseFromPlace(placeId: number): Promise<number> {
	return fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`)
	.then(async (response) => {
		let json = await response.json() as UniverseResponse;
		return parseInt(json.universeId || "0");
	})
	.catch(() => {
		return 0;
	});
}

async function getThumbnails(universeIds: number[]): Promise<Map<number, string>> {
	streamDeck.logger.info(universeIds);
	const thumbnails = new Map();
	if (universeIds.length == 0) {
		return thumbnails;
	}
	return fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeIds.join(',')}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`)
	.then(async (response) => {
		const requests = [];
		streamDeck.logger.info(response.status);
		streamDeck.logger.info(response.statusText);
		if (response.status === 200) {
			let json = await response.json() as ThumbnailResponse;
			streamDeck.logger.info(json);
			for (let thumbnailData of json.data) {
				streamDeck.logger.info(thumbnailData.imageUrl);
				requests.push(
					fetch(thumbnailData.imageUrl)
					.then(async (response) => {
						let blob = await response.blob();
						let contentType = response.headers.get("Content-Type")
						let buffer = Buffer.from(await blob.arrayBuffer())
						let thumbnail = `data:${contentType};base64,${buffer.toString("base64")}`
						thumbnails.set(parseInt(thumbnailData.targetId), thumbnail);
					})
				);
			}
		}
		await Promise.all(requests);
		return thumbnails;
	});
}

async function getPlayerCounts(universeIds: number[]): Promise<Map<number, string>> {
	const playerCounts = new Map();
	if (universeIds.length == 0) {
		return playerCounts;
	}
	return fetch(`https://games.roblox.com/v1/games?universeIds=${universeIds}`)
	.then(async (response) => {
		streamDeck.logger.info(response.status);
		if (response.status === 200) {
			let json = await response.json() as UniverseDataResponse;
			for (let universeData of json.data) {
				playerCounts.set(universeData.id, universeData.playing.toLocaleString());
			}
		}
		return playerCounts;
	});
}

@action({ UUID: "dev.ericfalk.roblox-stats.player-count" })
export class PlayerCount extends SingletonAction<CountSettings> {

	override async onWillAppear(ev: WillAppearEvent<CountSettings>): Promise<void> {
		streamDeck.logger.info("============ WILL APPEAR ============", ev.action.id);
		await registerAction(ev.action.id);
		await updateActions([ev.action]);
	}

	override async onWillDisappear(ev: WillDisappearEvent<CountSettings>): Promise<void> {
		streamDeck.logger.info("============ WILL DISAPPEAR ============", ev.action.id);
		await unregisterAction(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<CountSettings>): void {
		let placeId = ev.payload.settings.placeId;
		streamDeck.system.openUrl(`https://www.roblox.com/games/${placeId}/`);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CountSettings>): Promise<void> {
		streamDeck.logger.info("============ RECEIVED SETTINGS ============", ev.action.id);
		await updateActions([ev.action]);
	}

}

type CountSettings = {
	placeId?: number;
	count?: string;
};
