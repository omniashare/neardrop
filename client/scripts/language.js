(function() {
    let current_lang = localStorage.getItem('clanguage')
    if(! current_lang) {
        localStorage.setItem('clanguage','en')
    }
    jQuery.i18n.properties({ 
        name: current_lang, 
        path: '../language/',
        language: current_lang,
        cache: false,
        mode: 'map', 
        callback: function() { 
            $('#instructions').attr('desktop',$.i18n.prop('text_instructions_pc')).attr('mobile',$.i18n.prop('text_instructions_mobile'))
            for (let i in $.i18n.map) {
                $('[data-lang="' + i + '"]').text($.i18n.map[i]);
                $('[data-title="' + i + '"]').attr('title',$.i18n.map[i]);
                $('[data-placeholder="' + i + '"]').attr('placeholder',$.i18n.map[i]);
               
            }
        }
    });
})()
