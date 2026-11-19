import test from 'node:test';
import assert from 'node:assert/strict';
import { fitCardSphere, projectCardY } from './sphereLayout.js';

test('rotated card envelopes remain inside the viewport at every supported zoom', () => {
  for (const [width, height, cardWidth, cardHeight, top, bottom] of [
    [1920,1080,230,276,150,975], [960,640,194,233,135,535],
    [375,667,139,169,12,420], [667,260,139,169,12,110],
  ]) for (const zoom of [.65,1,1.35]) for (const count of [19,30]) {
    const layout=fitCardSphere({width,height,cardWidth,cardHeight,top,bottom,zoom,count,mobile:width<600});
    for (let i=0;i<30;i++) for (const tilt of [-1.08,0,1.08]) {
      const angle=i/30*Math.PI*2+tilt;
      const x=layout.centerX+Math.sin(angle)*layout.radiusX;
      const y=layout.centerY+Math.cos(angle)*layout.radiusY;
      const left=width/2+(x-layout.halfWidth-width/2)*layout.perspective;
      const right=width/2+(x+layout.halfWidth-width/2)*layout.perspective;
      const upper=height/2+(y-layout.halfHeight-height/2)*layout.perspective;
      const lower=height/2+(y+layout.halfHeight-height/2)*layout.perspective;
      assert.ok(left>=12-1e-6&&right<=width-12+1e-6);
      assert.ok(upper>=top-1e-6&&lower<=bottom+1e-6);
    }
  }
});

test('desktop retains original card size with balanced horizontal margins for 19 and 30 songs', () => {
  const input={width:1920,height:1080,cardWidth:230,cardHeight:276};
  const normal=fitCardSphere({...input,count:19});
  const full=fitCardSphere({...input,count:30});
  assert.equal(full.scale,1);
  assert.equal(full.scale,normal.scale);
  assert.equal(full.radiusX,1920*.32);
  assert.equal(fitCardSphere({...input,mobile:true,count:19}).scale,fitCardSphere({...input,mobile:true,count:30}).scale);
});

test('desktop vertical orbit can extend behind the player while staying inside the window', () => {
  const l=fitCardSphere({width:1480,height:1000,cardWidth:194,cardHeight:233,top:130,bottom:988});
  const scale=.67*l.scale;
  const bottom=l.centerY+projectCardY(l,.98,scale)+l.halfHeight*.67/1.1;
  assert.ok(bottom>950);
  assert.ok(500+(bottom-500)*l.perspective<=988+1e-6);
});

test('a short window scales the cards while retaining a nonzero draggable sphere', () => {
  const l=fitCardSphere({width:640,height:220,cardWidth:194,cardHeight:233,top:40,bottom:140,zoom:1.35});
  assert.ok(l.scale>0&&l.scale<1);
  assert.ok(l.radiusX>0&&l.radiusY>0);
});

test('desktop pole cards fill the vertical bounds at their actual depth scale without clipping', () => {
  const top = 42, bottom = 988, mid = 500;
  for (const zoom of [.65, 1, 1.35]) {
    const layout = fitCardSphere({ width: 1480, height: mid * 2, cardWidth: 194, cardHeight: 233, top, bottom, zoom });
    for (const cardScale of [.36, .67, .98, 1.078]) for (const yaw of [0, 8, 16]) {
      const ratio = cardScale / 1.1;
      const halfHeight = layout.halfHeight * ratio;
      const perspective = 1200 / (1200 - layout.halfWidth * ratio * Math.sin(yaw * Math.PI / 180));
      for (let i = 0; i <= 100; i++) {
        const center = layout.centerY + projectCardY(layout, i / 50 - 1, cardScale * layout.scale, yaw);
        assert.ok(mid + (center - halfHeight - mid) * perspective >= top - 1e-6);
        assert.ok(mid + (center + halfHeight - mid) * perspective <= bottom + 1e-6);
      }
    }
  }
  const layout = fitCardSphere({ width: 1480, height: mid * 2, cardWidth: 194, cardHeight: 233, top, bottom });
  const flatPoleCenter = layout.centerY + projectCardY(layout, -1, .67 * layout.scale, 0);
  assert.ok(Math.abs(flatPoleCenter - layout.halfHeight * .67 / 1.1 - top) < 1e-6);
});
