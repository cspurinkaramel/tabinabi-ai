import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({limit:"12mb"}));
app.use(express.static(path.join(dir,"public")));
const aiReady = Boolean(process.env.OPENAI_API_KEY);
const dbReady = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const ai = aiReady ? new OpenAI({apiKey:process.env.OPENAI_API_KEY}) : null;
const db = dbReady ? createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}) : null;

// 門司港レトロ周辺の既知スポット。DBを使う場合も座標が範囲内のスポットだけを判定候補にする。
const demoSpots = [
 {id:"mojiko-station",name:"門司港駅",area:"福岡県北九州市門司区",category:"歴史建築",description:"門司港のシンボルとして親しまれる歴史ある駅舎。",highlights:["駅舎のレトロな外観","港町の散策"],latitude:33.9456,longitude:130.9617},
 {id:"mojiko-mitsui",name:"旧門司三井倶楽部",area:"福岡県北九州市門司区",category:"歴史建築",description:"門司港レトロ地区にある歴史的な洋館。",highlights:["歴史的な洋館","建築の意匠"],latitude:33.9450,longitude:130.9641},
 {id:"blue-wing-moji",name:"ブルーウィングもじ",area:"福岡県北九州市門司区",category:"橋・景観",description:"門司港レトロ地区にある歩行者専用のはね橋。",highlights:["歩行者専用のはね橋","港の眺め"],latitude:33.9445,longitude:130.9661},
 {id:"mojiko-retro",name:"門司港レトロ",area:"福岡県北九州市門司区",category:"観光エリア",description:"歴史的な建物と港の景色が楽しめる観光エリア。",highlights:["歴史的な建物","港の景色"],latitude:33.9450,longitude:130.9650}
];
const CENTER={latitude:33.9450,longitude:130.9650};
const MAX_AREA_KM=2.5;
function distanceKm(a,b){
 const rad=x=>x*Math.PI/180, dLat=rad(b.latitude-a.latitude),dLon=rad(b.longitude-a.longitude);
 const h=Math.sin(dLat/2)**2+Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(dLon/2)**2;
 return 6371*2*Math.asin(Math.sqrt(h));
}
async function getSpots(){
 if(!db)return demoSpots;
 const {data,error}=await db.from("tourist_spots").select("*").order("name");
 if(error)throw error;
 // 座標のないDBレコードは、エリア内と確認できないため候補から除外。
 return (data||[]).filter(s=>Number.isFinite(Number(s.latitude))&&Number.isFinite(Number(s.longitude))&&
   distanceKm(CENTER,{latitude:Number(s.latitude),longitude:Number(s.longitude)})<=MAX_AREA_KM);
}
app.get("/api/health",(_req,res)=>res.json({ok:true,aiConfigured:aiReady,databaseConfigured:dbReady,mode:"mojiko-retro-only"}));
app.get("/api/spots",async(_req,res)=>{try{res.json({spots:await getSpots(),source:dbReady?"database":"demo"})}catch(e){console.error(e.message);res.status(500).json({error:"観光地データを読み込めません。DB設定を確認してください。"})}});

app.post("/api/identify",async(req,res)=>{
 const {imageDataUrl,useGps=false,gps=null}=req.body||{};
 if(typeof imageDataUrl!=="string"||!imageDataUrl.startsWith("data:image/"))return res.status(400).json({error:"画像を選択してください。"});
 if(!aiReady)return res.status(503).json({error:"AI未設定です。.env に OPENAI_API_KEY を設定してください。"});
 if(useGps&&(!gps||!Number.isFinite(Number(gps.latitude))||!Number.isFinite(Number(gps.longitude))))
   return res.status(400).json({error:"GPSを利用する設定ですが、位置情報を取得できませんでした。GPSの許可設定を確認するか、チェックを外して画像だけで判定してください。"});
 try{
  const spots=await getSpots();
  if(!spots.length)return res.status(500).json({error:"門司港レトロ周辺の判定候補がありません。スポットDBの緯度・経度を確認してください。"});
  const candidates=spots.map(s=>({id:s.id,name:s.name,area:s.area,category:s.category,description:s.description,highlights:s.highlights}));
  let gpsContext="GPS判定は使用しません。";
  let nearby=[];
  if(useGps){
   const userPoint={latitude:Number(gps.latitude),longitude:Number(gps.longitude)};
   const km=distanceKm(userPoint,CENTER);
   nearby=spots.map(s=>({...s,distanceKm:distanceKm(userPoint,{latitude:Number(s.latitude),longitude:Number(s.longitude)})})).sort((a,b)=>a.distanceKm-b.distanceKm);
   gpsContext=`GPS位置は門司港レトロ中心から約${km.toFixed(2)}kmです。最寄り登録候補は${nearby[0]?.name||"なし"}（約${nearby[0]?.distanceKm.toFixed(2)}km）。位置情報の出所: ${String(gps.source||"不明")}。`;
  }
  const prompt=`あなたは「門司港レトロ専用」の写真判定AIです。候補リストにある門司港レトロ周辺の場所だけを判定してください。一般的な観光地判定はしないでください。
写真の視覚的根拠を確認し、候補の中から最も近いものを第一候補とし、見た目が似ている別候補を最大3件、類似候補として返してください。写真から門司港レトロ周辺と判断できない場合、または根拠が弱い場合はmatched=falseにしてください。候補を無理に当てはめないこと。確信度は高・中・低。
GPS情報は補助証拠です。GPSだけを根拠に、写真に写っている建物を断定しないでください。画像の根拠とGPSが矛盾する場合はstampEligible=falseにしてください。
GPS情報: ${gpsContext}
候補リスト: ${JSON.stringify(candidates)}
日本語JSONのみで返答: {"matched":true,"spotId":"候補id","confidence":"高|中|低","visualEvidence":"画像で見える具体的な特徴","explanation":"短い説明","stampEligible":true,"gpsMessage":"位置情報についての説明","similarCandidates":[{"spotId":"候補id","reason":"似ている理由","confidence":"中"}]}。特定できない場合はmatched=false, spotId=null, stampEligible=false, similarCandidates=[]。`;
  const response=await ai.responses.create({model:"gpt-4.1-mini",input:[{role:"user",content:[
   {type:"input_text",text:prompt},{type:"input_image",image_url:imageDataUrl,detail:"auto"}
  ]}]});
  const match=(response.output_text||"").match(/\{[\s\S]*\}/);
  if(!match)throw new Error("AI output was not JSON");
  const parsed=JSON.parse(match[0]),spot=spots.find(s=>s.id===parsed.spotId);
  const gpsInside=!useGps||distanceKm({latitude:Number(gps.latitude),longitude:Number(gps.longitude)},CENTER)<=MAX_AREA_KM;
  const gpsNearest=useGps?nearby[0]:null;
  const gpsConsistent=!useGps||(gpsInside&&(!spot||!gpsNearest||gpsNearest.distanceKm>0.8||gpsNearest.id===spot.id));
  const matched=Boolean(parsed.matched&&spot&&["高","中"].includes(parsed.confidence));
  const stampEligible=Boolean(matched&&parsed.stampEligible!==false&&gpsConsistent);
  const similar=(Array.isArray(parsed.similarCandidates)?parsed.similarCandidates:[]).slice(0,3).map(c=>{
    const s=spots.find(x=>x.id===c.spotId);return s?{id:s.id,name:s.name,reason:String(c.reason||s.description),confidence:["高","中","低"].includes(c.confidence)?c.confidence:"低"}:null;
  }).filter(Boolean);
  if(spot&& !similar.some(c=>c.id===spot.id))similar.unshift({id:spot.id,name:spot.name,reason:String(parsed.visualEvidence||spot.description),confidence:parsed.confidence||"低"});
  res.json({matched,stampEligible,confidence:matched?parsed.confidence:"低",visualEvidence:String(parsed.visualEvidence||""),
   explanation:String(parsed.explanation||(matched?spot.description:"門司港レトロの登録候補から特定できませんでした。")),
   gpsMessage:useGps?`${String(gps.source||"GPS")}を確認。${gpsInside?"門司港レトロ周辺の範囲内です。":"門司港レトロの判定範囲外です。"}${gpsConsistent?"":" 写真の候補と位置情報が一致しない可能性があります。"}`:"",
   spot:matched?spot:null,candidates:similar});
 }catch(e){console.error("identify:",e.message);res.status(500).json({error:"判定に失敗しました。APIキー、利用上限、ネット接続を確認してください。"})}
});
app.get("/api/stamps/:visitorId",async(req,res)=>{
 const id=req.params.visitorId;if(!/^[0-9a-f-]{36}$/i.test(id))return res.status(400).json({error:"訪問者IDが正しくありません。"});
 if(!db)return res.json({stamps:[],source:"demo"});
 try{const {data,error}=await db.from("visitor_stamps").select("spot_id,earned_at").eq("visitor_id",id);if(error)throw error;res.json({stamps:data||[],source:"database"})}
 catch(e){console.error(e.message);res.status(500).json({error:"スタンプを読み込めませんでした。"})}
});
app.post("/api/stamps",async(req,res)=>{
 const {visitorId,spotId}=req.body||{};
 if(!/^[0-9a-f-]{36}$/i.test(visitorId||"")||typeof spotId!=="string")return res.status(400).json({error:"スタンプ情報が正しくありません。"});
 const spots=await getSpots().catch(()=>demoSpots);if(!spots.some(s=>s.id===spotId))return res.status(404).json({error:"門司港レトロの対象スポットが見つかりません。"});
 if(!db)return res.json({saved:true,source:"demo",message:"デモ応答です。Supabase設定後にDB保存されます。"});
 try{
  const {data:existing,error:readError}=await db.from("visitor_stamps").select("visitor_id").eq("visitor_id",visitorId).eq("spot_id",spotId).maybeSingle();
  if(readError)throw readError;if(existing)return res.status(409).json({error:"すでに獲得済みのスタンプです。"});
  const {data,error}=await db.from("visitor_stamps").insert({visitor_id:visitorId,spot_id:spotId}).select("visitor_id,spot_id,earned_at").single();
  if(error){if(error.code==="23505")return res.status(409).json({error:"すでに獲得済みのスタンプです。"});throw error;}
  res.json({saved:true,stamp:data,source:"database"});
 }catch(e){console.error(e.message);res.status(500).json({error:"保存できませんでした。データベース設定を確認してください。"})}
});
app.get("/{*splat}",(_req,res)=>res.sendFile(path.join(dir,"public","index.html")));
const port=Number(process.env.PORT||3000);app.listen(port,()=>console.log(`旅ナビAI: http://localhost:${port}`));
