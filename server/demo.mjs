import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';

// An intentionally deterministic training simulator. Live telephone calls use
// OpenAI Realtime, never this parser. It still writes through real booking rules.
export function createDemo(store) {
  const sessions = new Map();
  const say = (s, en, ur) => s.language === 'ur' ? ur : en;
  const prune = () => { for (const [id,s] of sessions) if(Date.now()-s.updated>30*60e3) sessions.delete(id); };
  return {
    async turn(input) {
      prune();
      const message = String(input.message || '').trim();
      if (!message || message.length > 1500) throw Object.assign(new Error('Enter a message of 1–1500 characters.'), {status:400});
      const catalog = await store.catalog();
      const salon = catalog.salon;
      let s = sessions.get(input.sessionId);
      if (!s) {
        if(sessions.size>=200) throw Object.assign(new Error('Demo is busy; try again shortly.'),{status:429});
        const call = await store.createCall({channel:'demo',status:'in-progress',language:'en',summary:'Interactive training conversation'});
        s = {id:randomUUID(),callId:call.id,stage:'service',language:'en',updated:Date.now()};
        sessions.set(s.id,s);
      }
      s.updated = Date.now();
      if (/[\u0600-\u06ff]/u.test(message) || input.language==='ur') s.language='ur';
      const lower = message.toLowerCase();
      const result = (reply, extra={}) => ({sessionId:s.id,reply,stage:s.stage,...extra});
      if(/reset|start over|دوبارہ/.test(lower)) { s.stage='service'; delete s.slot; }
      if (/human|receptionist|callback|انسان|نمائندہ/.test(lower)) {
        await store.updateCall(s.callId,{status:'needs-callback',summary:'Demo customer requested receptionist assistance'});
        return result(say(s,'I can flag this demo conversation for the receptionist. For a real callback, contact the salon at '+salon.phone+'.','میں نے اس ڈیمو گفتگو میں استقبالیہ کی مدد کی درخواست درج کر دی ہے۔ حقیقی رابطے کے لیے '+salon.phone+' پر رابطہ کریں۔'));
      }
      if(/price|cost|کتنے|قیمت/.test(lower)) return result(catalog.services.map(x=>`${x.name}: ${salon.currency} ${x.price} · ${x.durationMinutes} min`).join('\n'));
      if(/address|location|کہاں|پتہ/.test(lower)) return result(salon.address);
      if(/hours|open|بجے|اوقات/.test(lower) && !/book|کل|tomorrow/.test(lower)) return result(say(s,'Our configured opening hours are shown in Business settings. What service would you like to book?','ہمارے کاروباری اوقات سیٹنگز میں درج ہیں۔ آپ کون سی سروس بک کرنا چاہتے ہیں؟'));
      if(s.stage==='done') return result(say(s,'Your booking is saved. Type “start over” for another booking.','آپ کی بکنگ محفوظ ہے۔ نئی بکنگ کے لیے “start over” لکھیں۔'));
      if(s.stage==='service') {
        const selected=catalog.services.find(x=>lower.includes(x.name.toLowerCase())||lower===x.id.toLowerCase()) || (/hair|cut|بال/.test(lower)?catalog.services.find(x=>/hair|cut/i.test(x.name)):null);
        if(!selected) return result(say(s,'Hello! I’m SalonLine, the salon’s AI receptionist. This is a training demo. Which service would you like?\n'+catalog.services.map(x=>x.name).join(' · '),'السلام علیکم! میں سیلون کا اے آئی استقبالیہ ہوں۔ یہ تربیتی ڈیمو ہے۔ آپ کون سی سروس چاہتے ہیں؟\n'+catalog.services.map(x=>x.name).join(' · ')));
        s.service=selected; s.stage='date';
        if(!/tomorrow|today|\d{4}-\d{2}-\d{2}|کل|آج/.test(lower)) return result(say(s,`${selected.name}, ${salon.currency} ${selected.price}. What date? Try “tomorrow” or YYYY-MM-DD.`,`${selected.name}، ${salon.currency} ${selected.price}۔ کس تاریخ کو؟ “کل” یا YYYY-MM-DD لکھیں۔`));
      }
      if(s.stage==='date') {
        const now=DateTime.now().setZone(salon.timeZone);
        const date=message.match(/\d{4}-\d{2}-\d{2}/)?.[0] || (/tomorrow|کل/.test(lower)?now.plus({days:1}).toISODate():/today|آج/.test(lower)?now.toISODate():null);
        if(!date) return result(say(s,'Please enter a date as YYYY-MM-DD, or say “tomorrow”.','براہ کرم تاریخ YYYY-MM-DD میں یا “کل” لکھیں۔'));
        const available=await store.availability({date,serviceId:s.service.id});
        s.slots=available.slots.slice(0,5);
        if(!s.slots.length) return result(say(s,'There are no openings that day. Please choose another date.','اس دن کوئی وقت دستیاب نہیں۔ دوسری تاریخ بتائیں۔'));
        s.stage='slot';
        return result(say(s,'Choose a time by number:\n','نمبر لکھ کر وقت منتخب کریں:\n')+s.slots.map((x,i)=>`${i+1}. ${x.label} · ${x.stylistName}`).join('\n'));
      }
      if(s.stage==='slot') {
        const n=Number(message.replace(/[۱-۵]/g,c=>'۱۲۳۴۵'.indexOf(c)+1));
        if(!Number.isInteger(n)||n<1||n>s.slots.length) return result(say(s,'Choose one of the listed time numbers.','درج اوقات میں سے ایک نمبر لکھیں۔'));
        s.slot=s.slots[n-1];s.stage='name';
        return result(say(s,'What name should I put on the booking?','بکنگ کس نام پر کروں؟'));
      }
      if(s.stage==='name') {
        if(message.length<2||message.length>100) return result(say(s,'Please give a name between 2 and 100 characters.','براہ کرم اپنا نام لکھیں۔'));
        s.customerName=message;s.stage='phone';
        return result(say(s,'What is your phone number, including country code, for example +923001234567?','ملکی کوڈ کے ساتھ اپنا فون نمبر بتائیں، مثلاً +923001234567۔'));
      }
      if(s.stage==='phone') {
        const phone=message.replace(/[\s()-]/g,'');
        if(!/^\+[1-9]\d{7,14}$/.test(phone)) return result(say(s,'Use international format, starting with + and your country code.','فون نمبر + اور ملکی کوڈ کے ساتھ لکھیں۔'));
        s.phone=phone;s.stage='confirm';
        return result(say(s,`${s.customerName}: ${s.service.name} with ${s.slot.stylistName}, ${DateTime.fromISO(s.slot.startAt).setZone(salon.timeZone).toFormat('cccc, dd LLL yyyy · h:mm a')} (${salon.timeZone}), ${salon.currency} ${s.service.price}. Type “confirm” to save, or “start over”. Demo bookings do not send messages.`,`${s.customerName}: ${s.service.name}، ${s.slot.stylistName}، ${DateTime.fromISO(s.slot.startAt).setZone(salon.timeZone).toFormat('dd LLL yyyy h:mm a')} (${salon.timeZone})، ${salon.currency} ${s.service.price}۔ محفوظ کرنے کے لیے “تصدیق” لکھیں۔ ڈیمو میں پیغام نہیں بھیجا جاتا۔`));
      }
      if(s.stage==='confirm') {
        if(!/^(confirm|yes|تصدیق|جی|ہاں)[.! ]*$/iu.test(message)) return result(say(s,'Type “confirm” to create this appointment, or “start over”.','بکنگ محفوظ کرنے کے لیے “تصدیق” یا دوبارہ آغاز کے لیے “start over” لکھیں۔'));
        const booking=await store.createBooking({serviceId:s.service.id,stylistId:s.slot.stylistId,startAt:s.slot.startAt,customerName:s.customerName,phone:s.phone,channel:'demo',confirmed:true,whatsappConsent:false},`demo-${s.id}`);
        s.stage='done';
        await store.updateCall(s.callId,{status:'completed',summary:`Demo appointment confirmed: ${s.service.name}`,language:s.language});
        return result(say(s,`Booked! Your reference is ${booking.bookingCode}. You can see this demo appointment in Appointments. No WhatsApp message was sent.`,`بکنگ محفوظ ہو گئی! حوالہ ${booking.bookingCode} ہے۔ یہ ڈیمو بکنگ اپائنٹمنٹس میں موجود ہے۔ واٹس ایپ پیغام نہیں بھیجا گیا۔`),{booking});
      }
    },
    async end(id){const s=sessions.get(id);if(s&&s.stage!=='done')await store.updateCall(s.callId,{status:'completed',summary:'Demo conversation ended without a booking'});sessions.delete(id);return {ok:true};}
  };
}
